# P5a Authentication, Route Protection and Profile Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver spec section 11 for the web app: Supabase email/password and Google sign-in over PKCE, email verification and password reset flows, validated redirects, protected routes (`/portfolio`, `/analytics`, `/profile/*`) without a flash of protected content, the Profile page shell (Security complete; Broker and Notifications as replaceable placeholders), a profile bootstrap trigger and a redacting audit RPC in the database, a checked auth configuration, and an end-to-end test against the local Supabase stack. Broker linking (P5b), notification settings (P3) and CAPTCHA wiring are NOT part of this phase.

**Architecture:** Auth state lives in a framework-free `AuthStore` (`features/auth/auth-store.ts`) fed by `supabase.auth.onAuthStateChange`. `AuthProvider` exposes it to React with `useSyncExternalStore`; the same store instance is placed in the TanStack Router context so `beforeLoad` guards (`requireAuth`) read it synchronously. While the store is `loading` the guard lets the route load but the route component is wrapped in `AuthGate`, which renders a neutral skeleton and never the protected children; when the state resolves to `signed-out`, `AuthRouteSync` calls `router.invalidate()` and `requireAuth` redirects. Network calls live in `createAuthApi(client, { origin })` (a factory so Vitest injects a fake client); components reach the real instances through `features/auth/default.ts`, which Vitest replaces globally with an inert mock in `src/test/setup.ts`. All redirect targets pass through the pure function `safeNext`. The database side is one migration (`20261015003000_auth_profiles.sql`): a `SECURITY DEFINER` trigger creating the `profiles` row, own-row RLS plus column privileges, and the `public.record_audit` RPC that is the only way a browser can write `audit_events`.

**Tech Stack:** Bun 1.3.14 and Node 22.13.1 (Windows 11), TypeScript 6.0.3, Biome 2.5.15, React 19.3.1, TanStack Router 1.170.44 (code-based routes) and Query 5.104.2, `@supabase/supabase-js` 2.117.3 (`flowType: "pkce"`), zod 4.6.7, shadcn/ui (Radix) and Tailwind 4.3.3 from P0, Vitest 5.0.4 (`web` project, happy-dom 21.0.1, Testing Library 16.3.3), Playwright 1.64.1, Supabase CLI 2.121.0 (local stack, pgTAP, Mailpit mail viewer).

**Spec:** docs/superpowers/specs/2026-10-15-stock-screener-design.md (sections 6.3 `profiles` and `audit_events`, 6.8, 6.9, 11, 14.1, 14.3, 15, 16.9, 17, 18 P5), research `docs/discovery/research/supabase-push-email.md` sections 6 and 11, brief `prompt.txt` Part IX (lines 1026 to 1056) and Page 5 (lines 1579 to 1613).

**Prerequisites (earlier phases, not built here):** P0 (apps/web scaffold with `src/router.tsx`, `AppShell`, `ThemeProvider`, shadcn components, `sw-routes.ts`, Vitest `web` project, Playwright config, `supabase/config.toml`, `docs/operator-guide.md`), P1 (migrations creating `profiles (user_id PK -> auth.users, is_admin, created_at, ...)` and `audit_events` per spec 6.3) and P4 (`apps/web/src/lib/supabase.ts` anon client; Task 3 replaces that file and keeps its `supabase` export). Where a P1/P4 file was not yet written when this plan was authored, the names above are assumed.

## Global Constraints

- **Auth flow:** `@supabase/supabase-js` is created with exactly `auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }` (spec 11.1; the research does not state that PKCE is the default, so it is explicit and pinned by a test).
- **Redirect targets:** every `next` value (search param, OAuth `redirectTo`, post-sign-in navigation) is validated by `safeNext`: a string that starts with exactly one `/`, at most 512 characters, no scheme, no `//` prefix (also after one round of percent-decoding), no backslash and no ASCII control character; anything else becomes `/`. Targets under `/auth` also become `/` (no redirect loops). Absolute URLs are never accepted, even same-origin ones. The query parameter is named `next`.
- **Protected routes:** `/portfolio`, `/analytics`, `/profile` and every `/profile/*` child. Public routes: `/`, `/quotes`, `/about`, `/auth/*`. Unauthenticated users go to `/auth/sign-in?next=<path>`; while auth state is `loading` protected content is never rendered (neutral skeleton).
- **Auth routes:** `/auth/sign-in`, `/auth/sign-up`, `/auth/callback`, `/auth/reset` (request a reset email), `/auth/update-password` (set a new password after the recovery link), `/auth/signed-out`; `/auth/forgot` is an alias that redirects to `/auth/reset` (spec 14.1 name).
- **Navigation:** when signed in the top bar shows a user icon with the label "Profile" and a "Sign out" button; when signed out it shows "Sign in"; while loading it shows a fixed-size placeholder (no flicker between the two).
- **Security page:** shows the verified email read-only (badge "Verified" when `email_confirmed_at` is set); the password change form is shown ONLY when `hasPasswordIdentity(user)` is true; Google-only accounts get the explanation card instead of any password form; "Sign out of all devices" is offered to every account.
- **Password policy:** at least 10 characters with a lower-case letter, an upper-case letter and a digit (Supabase `minimum_password_length = 10`, `password_requirements = "lower_upper_letters_digits"`); maximum 72 characters (bcrypt limit). The same policy is enforced client-side by `passwordSchema`.
- **Secrets:** no service-role key, no `sb_secret_` key and no Google client secret in the browser; the SPA only knows `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Tokens, codes, passwords and emails are never logged (`console.*` calls in auth code may print an error `code` only). The Google client id and secret live in the Supabase dashboard (production) or `supabase/.env` (local, git-ignored).
- **Audit events (written through `public.record_audit`; allowed names match `^auth\.[a-z][a-z_]{2,39}$`):** `auth.password_changed` (profile change and recovery), `auth.method_changed` (the set of sign-in providers changed while setting a password), `auth.sign_out_all` (scope `global` or `others`). The RPC writes for `auth.uid()` only, redacts keys matching `token|secret|password|passwd|authorization|cookie|key|email` recursively, limits metadata to 2 KiB and 60 events per hour per user.
- **Supabase built-in email limits** (documented in the operator guide): without custom SMTP the built-in mailer sends at most 2 messages per hour per project; one sign-up confirmation or reset email per user per 60 seconds; sign-up, sign-in, recover, resend and user endpoints 30 requests per 5 minutes per IP; token refresh 150 per 5 minutes per IP. Custom SMTP (P3, Resend) raises the default to 30 messages per hour.
- **Apple sign-in is not required** and is not built; the `[auth.external.apple]` block stays disabled.
- **Local vs production:** `enable_confirmations = false` in the committed local config (the local stack auto-confirms so tests need no mail); production turns confirmations ON in the dashboard (spec 11.1). The production redirect allow-list contains only exact paths (`/auth/callback`, `/auth/update-password`); globstar patterns exist only for localhost.
- **Windows:** every command works in PowerShell; copy files with `Copy-Item`; no bash-only syntax in `package.json` scripts; Vitest, Vite and Playwright run under Node.
- **Conventions inherited from P0:** Biome (2 spaces, width 100, double quotes, semicolons, `useImportType`, no `any`), `tsc` strict flags including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, `@/` alias for `apps/web/src`, a conventional-commit commit at the end of every task, never commit `.env`, `supabase/.env` or local keys.

## Plan decisions that deviate from, or complete, the spec (record in the decision log)

1. Query parameter `next` replaces the spec's `redirect` (brief Task 4). One name is used everywhere.
2. Password reset: `/auth/reset` requests the email and `/auth/update-password` is the `redirectTo` target (the brief's names). The spec's `/auth/forgot` is kept as a redirect alias. The production allow-list therefore holds `/auth/callback` and `/auth/update-password`, not `/auth/reset` as written in spec 11.2.
3. "Sign out of all devices" is offered (spec 11.8 said it was not researched). It uses `signOut({ scope: "global" })`; the audit event is written before the call because the RPC needs the session.
4. The password change form asks for the current password and verifies it with `signInWithPassword` before `updateUser` (spec 11.3 UI-level re-authentication), in addition to new password and confirmation.
5. `record_audit` accepts only `auth.*` event types so a browser can never forge `broker.*`, `scan.*` or `admin.*` events; the redaction regex is the spec 15.6 list minus `crumb|endpoint|p256dh|auth` (irrelevant to auth metadata, and `auth` would hide provider names).
6. CAPTCHA (Turnstile, spec 11.6) is not wired in P5a; the operator guide notes it and recommends closing public sign-up after the intended users exist.
7. `PASSWORD_RECOVERY` is held in memory only; a recovery session redirects every protected route to `/auth/update-password` until the password is set. After a page reload the flag is gone and the (email-verified) session behaves like any other session; accepted because the recovery link already proved ownership of the mailbox.
8. The OAuth and confirmation `redirectTo` carries `?next=<path>` only when the target is not `/`, so the default case matches a precise allow-list entry exactly. Whether Supabase matches an allow-list entry that has no wildcard against a URL with a query string is UNVERIFIED (research 11.6 documents path matching only); the operator guide tells the operator to test a sign-in with a non-default `next` once in production. If Supabase rejects the redirect it falls back to the Site URL with `?code=`, where `detectSessionInUrl` still completes the exchange and `next` is lost (the user lands on `/`); the allow-list is NOT loosened to cover it. The e2e test cannot cover this (the local list uses globstar).

## Review Focus

Five failure modes follow from the spec but no happy-path feature test would exercise them; each is pinned by a named check.

1. **Open redirect through `next` (Tasks 3 and 4).** `?next=https://evil.com`, `//evil.com`, `/\evil`, `/%2F/evil.com`, `javascript:` and control-character tricks must all land on `/`. Pinned by the `safeNext` table test, the `buildCallbackUrl` test (the OAuth `redirectTo` only ever carries a validated path) and component tests that drive the sign-in and callback pages with hostile `next` values and assert the router location.
2. **OAuth callback lands on a cached SPA shell or consumes the code twice (Tasks 2, 3, 4).** A service worker or CDN serving a cached shell for `/auth/callback`, and `detectSessionInUrl` plus the callback page both exchanging the single-use code. Pinned by a test that every auth path is excluded from the navigation fallback and the cache (`sw-routes`), a `_headers` test requiring `Cache-Control: no-store` for `/auth/*`, `completeCallback` tests (session already established by supabase-js; in-flight de-duplication by code) and a Playwright test with a bogus code.
3. **`PASSWORD_RECOVERY` session misuse (Tasks 3 and 4).** A recovery link signs the user in; if that session may roam, anyone holding the link can reach `/portfolio` without setting a password, and the flag could leak into storage. Pinned by auth-store tests (flag set by the event, cleared by sign-out and `clearRecovery`, never written to `localStorage`/`sessionStorage`), a guard test (a recovery session is redirected from protected routes to `/auth/update-password`) and `/auth/update-password` reachability tests (no flag and no session redirects away; a signed-in non-recovery user goes to Profile).
4. **Guard flash of protected content (Task 4).** The first render happens before `getSession` resolves. Pinned by tests that render a protected route while the store is `loading` (skeleton present, heading absent), that a `loading` to `signed-out` transition redirects with the right `next`, and by `AuthGate` never rendering children unless the state is `signed-in` and not in recovery.
5. **Google-only user shown a password form (Tasks 3 and 5).** `identities` versus `app_metadata.providers`, stale metadata, users with both providers. Pinned by `identity.ts` fixture tests (password-only, Google-only, both, stale metadata, unknown) and `SecurityPage` component tests asserting that the password form is absent and the explanation present for Google-only users, and the form present for password users.

## Task Dependencies and Concurrency

| Task | Depends on | Can run concurrently with |
|---|---|---|
| 1 Database | P1 migrations | Task 2 (disjoint files) |
| 2 Auth configuration | P0 | Task 1 |
| 3 Web auth core | P0 (and the P4 client file if present) | Tasks 1 and 2 (disjoint files; needs no database) |
| 4 Auth routes and guards | Task 3 | Task 5, steps 1 to 6 only |
| 5 Profile pages | Task 3; its Step 7 (router and setup wiring) needs Task 4 merged | Task 4 (disjoint files until Step 7) |
| 6 E2E | Tasks 1 to 5 | none |
| 7 Exit checklist | all | none |

Tasks 4 and 5 both edit `apps/web/src/router.tsx` and `apps/web/src/test/setup.ts`; Task 5 therefore edits them only in Step 7, after Task 4 is merged.

---

### Task 1: Database - profile bootstrap, profile RLS and the audit RPC

**Concurrency:** may run at the same time as Task 2 and Task 3 (disjoint files).

**Files:**
- Create: `supabase/migrations/20261015003000_auth_profiles.sql`
- Create: `supabase/tests/0300_auth_profiles.test.sql` (if P0 Task 5 had to move the smoke test to `supabase/tests/database/`, put this file next to it)

**Interfaces:**
- Consumes: P1 tables `public.profiles` and `public.audit_events` (spec 6.3), schema `app` from P0.
- Produces: trigger `on_auth_user_created` on `auth.users` calling `app.handle_new_user()`; `app.profile_display_name(jsonb)`; `profiles.display_name`, `profiles.updated_at` (maintained by trigger); policies `profiles_select_own`, `profiles_update_own`, `audit_events_select_own`; column grants (clients can select `user_id, display_name, created_at, updated_at` plus P1's `timezone`, `default_destination` when those columns exist, and update `display_name`, `timezone`, `default_destination`; `is_admin` is never granted); `public.record_audit(p_type text, p_meta jsonb) returns void` (granted to `authenticated` only); `app.redact_jsonb(jsonb)`.

- [ ] **Step 1: Check the migration order and the starting point**

Run (PowerShell): `Get-ChildItem supabase/migrations | Select-Object -ExpandProperty Name`
Expected: P0 and P1 files, all sorting before `20261015003000_auth_profiles.sql`, and one of them creating `profiles` and `audit_events`. If any P1 migration sorts after `20261015003000`, rename the new migration to a later timestamp (keep the `_auth_profiles.sql` suffix) and use that name everywhere below.

Run: `bun run supabase:start`
Expected: `Started supabase local development setup.` (or the stack is already running).

- [ ] **Step 2: Write the pgTAP test first**

`supabase/tests/0300_auth_profiles.test.sql`:

```sql
begin;
select plan(34);

-- helper: set the JWT claims that auth.uid() reads; the role is switched by the statement that follows
create function pg_temp.set_claims(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid = '' then '{"role":"authenticated"}'
         else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

-- three users; the trigger must create their profiles
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'alice@example.test', '{"full_name":"Alice Example"}', '{"provider":"google","providers":["google"]}', now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'bob@example.test', '{"display_name":"  Bob  "}', '{"provider":"email","providers":["email"]}', now(), now()),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'carol@example.test', '{}', '{"provider":"email","providers":["email"]}', now(), now());

-- 1-8: bootstrap trigger and columns (as the table owner)
select has_function('app', 'handle_new_user', 'app.handle_new_user() exists');
select trigger_is('auth', 'users', 'on_auth_user_created', 'app', 'handle_new_user', 'auth.users insert trigger is installed');
select has_column('public', 'profiles', 'display_name', 'profiles.display_name exists');
select has_column('public', 'profiles', 'updated_at', 'profiles.updated_at exists');
select is((select display_name from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'),
  'Alice Example', 'display name falls back to full_name (Google users)');
select is((select display_name from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'),
  'Bob', 'display_name metadata is trimmed');
select is((select display_name from public.profiles where user_id = '33333333-3333-4333-8333-333333333333'),
  null, 'no metadata gives a null display name');
select is((select count(*)::int from public.profiles where user_id in
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333')),
  3, 'one profile row per new user');

-- 9-17: user A against profiles and audit_events
select pg_temp.set_claims('11111111-1111-4111-8111-111111111111');
set local role authenticated;

select is((select count(*)::int from public.profiles), 1, 'A sees exactly one profile row');
select is((select count(*)::int from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'),
  0, 'A cannot read B''s profile');
select lives_ok($$update public.profiles set display_name = 'Hacked'
  where user_id = '22222222-2222-4222-8222-222222222222'$$, 'A updating B''s row is a silent no-op (RLS filters it)');
select lives_ok($$update public.profiles set display_name = 'Alice Updated'
  where user_id = '11111111-1111-4111-8111-111111111111'$$, 'A can update her own display name');
select is((select display_name from public.profiles), 'Alice Updated', 'the update is visible to A');
select throws_ok($$update public.profiles set is_admin = true
  where user_id = '11111111-1111-4111-8111-111111111111'$$, '42501', null, 'A cannot make herself admin');
select throws_ok($$insert into public.profiles (user_id) values ('44444444-4444-4444-8444-444444444444')$$,
  '42501', null, 'clients cannot insert profiles');
select throws_ok($$delete from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'$$,
  '42501', null, 'clients cannot delete profiles');
select throws_ok($$insert into public.audit_events (actor, actor_user_id, event_type)
  values ('user', '11111111-1111-4111-8111-111111111111', 'auth.forged')$$,
  '42501', null, 'clients cannot insert audit_events directly');

-- 18-26: the audit RPC for A
select lives_ok($$select public.record_audit('auth.password_changed',
  '{"via":"profile","new_password":"x","nested":{"Access_Token":"t"},"list":[{"secret":"s"}]}'::jsonb)$$,
  'record_audit succeeds for an authenticated caller');
select is((select count(*)::int from public.audit_events where event_type = 'auth.password_changed'),
  1, 'A reads her own audit row');
select is((select actor_user_id from public.audit_events where event_type = 'auth.password_changed'),
  '11111111-1111-4111-8111-111111111111'::uuid, 'the row belongs to the caller');
select is((select data ->> 'via' from public.audit_events where event_type = 'auth.password_changed'),
  'profile', 'harmless metadata is kept');
select is((select data ->> 'new_password' from public.audit_events where event_type = 'auth.password_changed'),
  '[redacted]', 'password keys are redacted');
select is((select data #>> '{nested,Access_Token}' from public.audit_events where event_type = 'auth.password_changed'),
  '[redacted]', 'nested token keys are redacted (case-insensitive)');
select is((select data #>> '{list,0,secret}' from public.audit_events where event_type = 'auth.password_changed'),
  '[redacted]', 'keys inside arrays are redacted');
select throws_ok($$select public.record_audit('broker.link', '{}'::jsonb)$$, '22023', null,
  'event types outside auth.* are rejected');
select throws_ok($$select public.record_audit('auth.x', '{}'::jsonb)$$, '22023', null,
  'malformed event types are rejected');

-- 27: B's profile is untouched (checked as the table owner)
reset role;
select is((select display_name from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'),
  'Bob', 'A''s update attempt did not change B''s profile');

-- 28-31: user B is isolated from A's audit rows
select pg_temp.set_claims('22222222-2222-4222-8222-222222222222');
set local role authenticated;

select lives_ok($$select public.record_audit('auth.sign_out_all', '{"scope":"global"}'::jsonb)$$,
  'B can record an event');
select is((select count(*)::int from public.audit_events), 1, 'B sees only her own audit rows');
select is((select count(*)::int from public.audit_events where event_type = 'auth.password_changed'),
  0, 'B cannot see A''s audit rows');
select is((select count(*)::int from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'),
  0, 'B cannot read A''s profile');

-- 32: a caller without a subject is refused
reset role;
select pg_temp.set_claims('');
set local role authenticated;
select throws_ok($$select public.record_audit('auth.password_changed', '{}'::jsonb)$$, '28000', null,
  'record_audit needs auth.uid()');

-- 33: anon cannot execute the RPC
reset role;
set local role anon;
select throws_ok($$select public.record_audit('auth.password_changed', '{}'::jsonb)$$, '42501', null,
  'anon cannot call record_audit');

-- 34: per-user hourly cap
reset role;
insert into public.audit_events (actor, actor_user_id, event_type)
  select 'user', '33333333-3333-4333-8333-333333333333', 'auth.seed_event' from generate_series(1, 60);
select pg_temp.set_claims('33333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok($$select public.record_audit('auth.password_changed', '{}'::jsonb)$$, '54000', null,
  'record_audit is capped at 60 events per hour');

reset role;
select * from finish();
rollback;
```

- [ ] **Step 3: Run it to confirm the failure**

Run: `bun run test:db`
Expected: FAIL. `0300_auth_profiles.test.sql` aborts at the first assertion (`app.handle_new_user() exists` fails, later statements error with `function public.record_audit(text, jsonb) does not exist`). `0001_smoke.test.sql` still passes.

- [ ] **Step 4: Write the migration**

`supabase/migrations/20261015003000_auth_profiles.sql`:

```sql
-- P5a: profile bootstrap, own-row profile access, audit RPC (spec 6.3, 6.8, 6.9, 11.9).

do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.audit_events') is null then
    raise exception 'P5a needs public.profiles and public.audit_events from P1';
  end if;
end $$;

-- 1. profile columns ---------------------------------------------------------------------------
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles drop constraint if exists profiles_display_name_length;
alter table public.profiles add constraint profiles_display_name_length
  check (display_name is null or char_length(display_name) between 1 and 60);

create or replace function app.touch_updated_at() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function app.touch_updated_at();

-- 2. bootstrap trigger -------------------------------------------------------------------------
create or replace function app.profile_display_name(p_meta jsonb) returns text
language sql immutable set search_path = '' as $$
  select left(coalesce(
    nullif(btrim(p_meta ->> 'display_name'), ''),
    nullif(btrim(p_meta ->> 'full_name'), ''),
    nullif(btrim(p_meta ->> 'name'), '')), 60)
$$;

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, app.profile_display_name(new.raw_user_meta_data))
  on conflict (user_id) do nothing;
  return new;
end $$;

revoke all on function app.handle_new_user() from public, anon, authenticated;
revoke all on function app.touch_updated_at() from public, anon, authenticated;
-- the auth service inserts into auth.users, so its role must be able to reach the function
grant usage on schema app to supabase_auth_admin;
grant execute on function app.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- users that signed up before this migration
insert into public.profiles (user_id, display_name)
select u.id, app.profile_display_name(u.raw_user_meta_data) from auth.users u
on conflict (user_id) do nothing;

-- 3. profiles: own-row access, no client insert/delete, is_admin never exposed ---------------------
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;

do $$
declare
  v_select text;
  v_update text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_select
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name in ('user_id', 'display_name', 'timezone', 'default_destination', 'created_at', 'updated_at');
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_update
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name in ('display_name', 'timezone', 'default_destination');
  execute format('grant select (%s) on public.profiles to authenticated', v_select);
  execute format('grant update (%s) on public.profiles to authenticated', v_update);
end $$;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 4. audit_events: read own rows, write only through record_audit -----------------------------------
alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon, authenticated;
grant select (id, at, actor_user_id, event_type, target_type, target_id, data)
  on public.audit_events to authenticated;

drop policy if exists audit_events_select_own on public.audit_events;
create policy audit_events_select_own on public.audit_events for select to authenticated
  using (actor_user_id = (select auth.uid()));

create or replace function app.redact_jsonb(p_value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb;
begin
  if p_value is null then
    return null;
  end if;
  case jsonb_typeof(p_value)
    when 'object' then
      v_out := '{}'::jsonb;
      for v_key, v_val in select e.key, e.value from jsonb_each(p_value) e loop
        if v_key ~* 'token|secret|password|passwd|authorization|cookie|key|email' then
          v_out := v_out || jsonb_build_object(v_key, '[redacted]');
        else
          v_out := v_out || jsonb_build_object(v_key, app.redact_jsonb(v_val));
        end if;
      end loop;
      return v_out;
    when 'array' then
      return coalesce((select jsonb_agg(app.redact_jsonb(e.value)) from jsonb_array_elements(p_value) e), '[]'::jsonb);
    else
      return p_value;
  end case;
end $$;

revoke all on function app.redact_jsonb(jsonb) from public, anon, authenticated;

create or replace function public.record_audit(p_type text, p_meta jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_meta jsonb;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_type is null or p_type !~ '^auth\.[a-z][a-z_]{2,39}$' then
    raise exception 'event type not allowed' using errcode = '22023';
  end if;
  v_meta := case when p_meta is not null and jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end;
  if pg_column_size(v_meta) > 2048 then
    raise exception 'metadata too large' using errcode = '22023';
  end if;
  if (select count(*) from public.audit_events
      where actor = 'user' and actor_user_id = v_uid and at > now() - interval '1 hour') >= 60 then
    raise exception 'audit rate limit reached' using errcode = '54000';
  end if;
  insert into public.audit_events (actor, actor_user_id, event_type, data)
  values ('user', v_uid, p_type, app.redact_jsonb(v_meta));
end $$;

revoke all on function public.record_audit(text, jsonb) from public, anon;
grant execute on function public.record_audit(text, jsonb) to authenticated;
```

Notes for the implementer: `grant select (...)` and `grant update (...)` are built dynamically so the migration works whether or not P1 already created `timezone` and `default_destination`; `is_admin` is never in either list. If P1 created differently named own-row policies on `profiles`, they stay (permissive policies are OR-ed and are all own-row, so they cannot widen access); check with `\dp public.profiles` in `supabase db diff` output and remove duplicates in this migration only if they are redundant.

- [ ] **Step 5: Apply the migrations and run the database tests**

Run: `bun run supabase:reset`
Expected: the migrations apply in order and the output ends with `Finished supabase db reset on branch ...`. If it reports `permission denied for table users` on the trigger, record it in the results file (hosted-project fallback below) and create the trigger from `supabase/seed.sql` instead; do not weaken the migration.

Run: `bun run test:db`
Expected: `0001_smoke.test.sql .. ok`, `0300_auth_profiles.test.sql .. ok`, `Files=2` (plus any P1 files), `Tests=...`, `Result: PASS`.

Hosted note (UNVERIFIED, spec 11.9): creating a trigger on `auth.users` through `supabase db push` is expected to work (it is the pattern in the Supabase user-management guide) but has not been run against the hosted project; Task 7's checklist includes the first-sign-up check. If `db push` rejects it, run the `create trigger on_auth_user_created ...` statement once in the dashboard SQL editor and record that in the operator guide.

- [ ] **Step 6: Commit**

```text
git add supabase/migrations/20261015003000_auth_profiles.sql supabase/tests/0300_auth_profiles.test.sql
git commit -m "feat(db): add profile bootstrap trigger, own-row profile access and audit RPC"
```

---

### Task 2: Supabase Auth configuration, config checker and operator guide

**Concurrency:** may run at the same time as Task 1 and Task 3 (disjoint files).

**Files:**
- Modify: `supabase/config.toml`, `package.json` (root), `docs/operator-guide.md`, `.github/workflows/ci.yml`
- Create: `supabase/.env.example`, `tools/lib/auth-config.ts`, `tools/lib/auth-config.test.ts`, `tools/check-auth-config.ts`

**Interfaces:**
- Consumes: `supabase/config.toml` from P0 (already sets `site_url = "http://localhost:5173"` and two redirect URLs).
- Produces: `parseToml(text): TomlSections`, `checkAuthConfig(toml, options?): string[]`, `PRODUCTION_SITE_PLACEHOLDER` (`"https://screener.example.com"`), `REQUIRED_PRODUCTION_PATHS` from `tools/lib/auth-config.ts`; root script `check:auth-config` (prints `auth config: OK (N redirect urls)`); local env file contract `supabase/.env` with `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`; operator guide section 3.

- [ ] **Step 1: Write the failing tests**

`tools/lib/auth-config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkAuthConfig,
  PRODUCTION_SITE_PLACEHOLDER,
  parseToml,
  REQUIRED_PRODUCTION_PATHS,
} from "./auth-config.ts";

const VALID = `
project_id = "stock-screener"

[auth]
enabled = true
site_url = "http://localhost:5173" # local stack
additional_redirect_urls = [
  "http://localhost:5173/**",
  "http://127.0.0.1:5173/**",
  "https://screener.example.com/auth/callback",
  "https://screener.example.com/auth/update-password",
]
minimum_password_length = 10
password_requirements = "lower_upper_letters_digits"

[auth.email]
enable_confirmations = false

[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
skip_nonce_check = false
`;

function without(text: string, line: string): string {
  expect(text).toContain(line);
  return text.replace(line, "");
}

function replaced(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe("parseToml", () => {
  it("reads sections, scalars, comments and multi-line arrays", () => {
    const sections = parseToml(VALID);
    expect(sections.get("auth")?.get("site_url")).toBe("http://localhost:5173");
    expect(sections.get("auth")?.get("minimum_password_length")).toBe(10);
    expect(sections.get("auth.email")?.get("enable_confirmations")).toBe(false);
    expect(sections.get("auth")?.get("additional_redirect_urls")).toEqual([
      "http://localhost:5173/**",
      "http://127.0.0.1:5173/**",
      "https://screener.example.com/auth/callback",
      "https://screener.example.com/auth/update-password",
    ]);
  });
});

describe("checkAuthConfig", () => {
  it("accepts the reference configuration", () => {
    expect(checkAuthConfig(VALID)).toEqual([]);
  });

  it("requires the production callback and update-password paths", () => {
    for (const path of REQUIRED_PRODUCTION_PATHS) {
      const broken = without(VALID, `  "${PRODUCTION_SITE_PLACEHOLDER}${path}",\n`);
      expect(checkAuthConfig(broken)).toContain(
        `redirect allow-list is missing ${PRODUCTION_SITE_PLACEHOLDER}${path}`,
      );
    }
  });

  it("checks a real production URL when one is given", () => {
    const problems = checkAuthConfig(VALID, { productionSiteUrl: "https://stocks.example.org/" });
    expect(problems).toContain("redirect allow-list is missing https://stocks.example.org/auth/callback");
  });

  it("rejects a wildcard host", () => {
    const broken = replaced(VALID, '"http://127.0.0.1:5173/**",', '"https://*.example.com/**",');
    const problems = checkAuthConfig(broken);
    expect(problems.some((p) => p.includes("wildcard in the host"))).toBe(true);
  });

  it("rejects a bare wildcard entry and a non-local wildcard path", () => {
    expect(checkAuthConfig(replaced(VALID, '"http://127.0.0.1:5173/**",', '"*",')).length).toBeGreaterThan(0);
    const wildcardPath = replaced(
      VALID,
      '"https://screener.example.com/auth/callback",',
      '"https://screener.example.com/**",',
    );
    expect(checkAuthConfig(wildcardPath).some((p) => p.includes("production entries are exact paths"))).toBe(true);
  });

  it("rejects plain http for a non-local host", () => {
    const broken = replaced(
      VALID,
      '"https://screener.example.com/auth/callback",',
      '"http://screener.example.com/auth/callback",',
    );
    expect(checkAuthConfig(broken).some((p) => p.includes("must use https"))).toBe(true);
  });

  it("requires a local site_url", () => {
    const broken = replaced(VALID, 'site_url = "http://localhost:5173"', 'site_url = "https://screener.example.com"');
    expect(checkAuthConfig(broken).some((p) => p.includes("site_url"))).toBe(true);
  });

  it("enforces the password policy", () => {
    expect(checkAuthConfig(replaced(VALID, "minimum_password_length = 10", "minimum_password_length = 6"))).toContain(
      "auth.minimum_password_length must be at least 10 (found 6)",
    );
    expect(
      checkAuthConfig(replaced(VALID, 'password_requirements = "lower_upper_letters_digits"', 'password_requirements = ""'))
        .some((p) => p.includes("password_requirements")),
    ).toBe(true);
  });

  it("requires Google with env references, never literal secrets", () => {
    const literal = replaced(
      VALID,
      'secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"',
      'secret = "GOCSPX-literal-secret"',
    );
    expect(checkAuthConfig(literal).some((p) => p.includes("secret must be an env(NAME) reference"))).toBe(true);
    expect(checkAuthConfig(replaced(VALID, "skip_nonce_check = false", "skip_nonce_check = true"))).toContain(
      "[auth.external.google] skip_nonce_check must be false",
    );
    const disabled = replaced(VALID, "[auth.external.google]\nenabled = true", "[auth.external.google]\nenabled = false");
    expect(checkAuthConfig(disabled)).toContain("[auth.external.google] enabled must be true");
    const missing = VALID.slice(0, VALID.indexOf("[auth.external.google]"));
    expect(checkAuthConfig(missing)).toContain("[auth.external.google] block is missing");
  });
});

describe("supabase/config.toml", () => {
  it("passes the auth configuration check", () => {
    const text = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
    expect(checkAuthConfig(text)).toEqual([]);
  });
});
```

Run: `bun run test:tools -- auth-config`
Expected: FAIL, `Failed to resolve import "./auth-config.ts"`.

- [ ] **Step 2: Implement `tools/lib/auth-config.ts`**

```ts
/**
 * Static checks for the Supabase Auth section of supabase/config.toml (spec 11.1, 11.2).
 * The committed file describes the LOCAL stack; production values are set in the dashboard and
 * documented in docs/operator-guide.md section 3. The checks keep the allow-list free of wildcard
 * hosts, keep the production paths exact, and keep OAuth secrets out of the repository.
 */

export type TomlValue = string | number | boolean | string[];
export type TomlSections = Map<string, Map<string, TomlValue>>;

export const PRODUCTION_SITE_PLACEHOLDER = "https://screener.example.com";
export const REQUIRED_PRODUCTION_PATHS = ["/auth/callback", "/auth/update-password"] as const;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== "\\") inString = !inString;
    if (char === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): TomlValue | undefined {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  return quoted ? (quoted[1] ?? "") : undefined;
}

function parseStringArray(raw: string): string[] {
  const values: string[] = [];
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) values.push(match[1] ?? "");
  return values;
}

/** Minimal TOML reader: sections, scalars, string arrays (also multi-line), comments. */
export function parseToml(text: string): TomlSections {
  const sections: TomlSections = new Map([["", new Map()]]);
  let current = "";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index] ?? "").trim();
    if (line === "") continue;
    const header = /^\[([^[\]]+)\]$/.exec(line);
    if (header) {
      current = (header[1] ?? "").trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.startsWith("[")) {
      while (!/\]\s*$/.test(value) && index + 1 < lines.length) {
        index += 1;
        value += ` ${stripComment(lines[index] ?? "").trim()}`;
      }
      sections.get(current)?.set(key, parseStringArray(value));
      continue;
    }
    const scalar = parseScalar(value);
    if (scalar !== undefined) sections.get(current)?.set(key, scalar);
  }
  return sections;
}

function splitUrl(entry: string): { scheme: string; hostname: string; path: string; host: string } | null {
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(entry);
  if (!match) return null;
  const host = match[2] ?? "";
  return { scheme: match[1] ?? "", host, hostname: host.replace(/:\d+$/, ""), path: match[3] ?? "" };
}

export interface AuthConfigOptions {
  /** Production site origin that the allow-list must contain; defaults to the documented placeholder. */
  productionSiteUrl?: string;
}

export function checkAuthConfig(toml: string, options: AuthConfigOptions = {}): string[] {
  const sections = parseToml(toml);
  const auth = sections.get("auth");
  const problems: string[] = [];
  const base = (options.productionSiteUrl ?? PRODUCTION_SITE_PLACEHOLDER).replace(/\/+$/, "");

  const siteUrl = auth?.get("site_url");
  if (typeof siteUrl !== "string") {
    problems.push("auth.site_url is missing");
  } else {
    const parts = splitUrl(siteUrl);
    if (!parts || !LOCAL_HOSTNAMES.has(parts.hostname)) {
      problems.push(`auth.site_url must be a local http URL in the committed config (found ${siteUrl}); production uses the dashboard`);
    }
  }

  const list = auth?.get("additional_redirect_urls");
  const entries = Array.isArray(list) ? list : [];
  if (entries.length === 0) problems.push("auth.additional_redirect_urls is empty");
  for (const entry of entries) {
    const parts = splitUrl(entry);
    if (!parts) {
      problems.push(`redirect url "${entry}" is not an absolute http(s) URL`);
      continue;
    }
    if (parts.host.includes("*")) {
      problems.push(`redirect url "${entry}" has a wildcard in the host`);
      continue;
    }
    const local = LOCAL_HOSTNAMES.has(parts.hostname);
    if (!local && parts.scheme !== "https") {
      problems.push(`redirect url "${entry}" must use https unless it targets localhost or 127.0.0.1`);
    }
    if (!local && parts.path.includes("*")) {
      problems.push(`redirect url "${entry}" uses a wildcard path but is not local (production entries are exact paths)`);
    }
  }
  for (const path of REQUIRED_PRODUCTION_PATHS) {
    if (!entries.includes(`${base}${path}`)) {
      problems.push(`redirect allow-list is missing ${base}${path}`);
    }
  }

  const minimum = auth?.get("minimum_password_length");
  if (typeof minimum !== "number" || minimum < 10) {
    problems.push(`auth.minimum_password_length must be at least 10 (found ${String(minimum)})`);
  }
  const requirements = auth?.get("password_requirements");
  if (typeof requirements !== "string" || requirements === "") {
    problems.push('auth.password_requirements must be set (use "lower_upper_letters_digits")');
  }

  if (typeof sections.get("auth.email")?.get("enable_confirmations") !== "boolean") {
    problems.push("[auth.email] enable_confirmations must be a boolean");
  }

  const google = sections.get("auth.external.google");
  if (!google) {
    problems.push("[auth.external.google] block is missing");
  } else {
    if (google.get("enabled") !== true) problems.push("[auth.external.google] enabled must be true");
    for (const key of ["client_id", "secret"] as const) {
      const value = google.get(key);
      if (typeof value !== "string" || !/^env\([A-Z][A-Z0-9_]*\)$/.test(value)) {
        problems.push(`[auth.external.google] ${key} must be an env(NAME) reference`);
      }
    }
    if (google.get("skip_nonce_check") !== false) {
      problems.push("[auth.external.google] skip_nonce_check must be false");
    }
  }
  return problems;
}
```

Run: `bun run test:tools -- auth-config`
Expected: the `parseToml` and `checkAuthConfig` tests pass; the last test (`supabase/config.toml passes ...`) still FAILS because the config has not been edited yet.

- [ ] **Step 3: Write the CLI and the script entries**

`tools/check-auth-config.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAuthConfig, parseToml } from "./lib/auth-config.ts";

const configPath = fileURLToPath(new URL("../supabase/config.toml", import.meta.url));
const flag = process.argv.find((arg) => arg.startsWith("--production-url="));
const productionSiteUrl = flag ? flag.slice("--production-url=".length) : undefined;

const text = readFileSync(configPath, "utf8");
const problems = checkAuthConfig(text, productionSiteUrl ? { productionSiteUrl } : {});

if (problems.length > 0) {
  console.error("auth config: FAILED");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
const urls = parseToml(text).get("auth")?.get("additional_redirect_urls");
console.log(`auth config: OK (${Array.isArray(urls) ? urls.length : 0} redirect urls)`);
```

In root `package.json` `scripts` add (keep the existing entries):

```json
    "check:auth-config": "bun run tools/check-auth-config.ts",
```

- [ ] **Step 4: Edit `supabase/config.toml` and add `supabase/.env.example`**

Run (PowerShell): `Select-String -Path supabase/config.toml -Pattern 'additional_redirect_urls|minimum_password_length|password_requirements|auth\.external\.(apple|google)|enable_confirmations'`
Expected: the lines P0 left or the CLI generated (`minimum_password_length = 6`, `password_requirements = ""`, `[auth.external.apple]`, two `enable_confirmations` lines for email and sms). Do not change `enable_confirmations`; it stays `false` locally (the check requires only a boolean).

Edit 1: replace the `additional_redirect_urls` line written in P0 with:

```toml
additional_redirect_urls = [
  "http://localhost:5173/**",
  "http://127.0.0.1:5173/**",
  # production entries are exact paths; replace the placeholder host with the real domain in the dashboard
  "https://screener.example.com/auth/callback",
  "https://screener.example.com/auth/update-password",
]
```

Edit 2: set `minimum_password_length = 10` and `password_requirements = "lower_upper_letters_digits"` (replace the generated values; the keys live directly under `[auth]`).

Edit 3: if a `[auth.external.google]` block exists replace the whole block, otherwise insert this block immediately before `[auth.external.apple]` (leave Apple untouched and disabled):

```toml
[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
skip_nonce_check = false
```

`supabase/.env.example`:

```dotenv
# Copy to supabase/.env (git-ignored): Copy-Item supabase/.env.example supabase/.env
# The Supabase CLI substitutes env(NAME) references in config.toml from this file.
# The placeholders let the stack start; "Continue with Google" only works locally with a real
# Google OAuth client whose redirect URI is http://127.0.0.1:54321/auth/v1/callback.
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=local-placeholder.apps.googleusercontent.com
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=local-placeholder-secret
```

Run: `Copy-Item supabase/.env.example supabase/.env` then `git status --short supabase/.env` (expected: no output, the file is ignored).

- [ ] **Step 5: Run the checks and restart the stack**

Run: `bun run test:tools -- auth-config`
Expected: all `auth-config` tests pass (11), including the real `config.toml` check.

Run: `bun run check:auth-config`
Expected: `auth config: OK (4 redirect urls)`.

Run: `bun run supabase:stop` then `bun run supabase:start`
Expected: the stack starts without `Missing required field` errors about `auth.external.google`. If the CLI still rejects the block, read the exact message, fix the key in `config.toml` (the checker will keep guarding the result) and note it in the results file.

Local mail viewer: the stack serves Mailpit (older CLI versions: Inbucket) at `http://127.0.0.1:54324`; every auth email sent locally appears there. Used by the manual checks in Task 7.

- [ ] **Step 6: Add the CI step**

Run: `Select-String -Path .github/workflows/ci.yml -Pattern 'check:functions-config'`
Add directly after that step (same indentation as the neighbouring steps):

```yaml
      - run: bun run check:auth-config
```

Run: `bun run lint:workflows`
Expected: `workflows: OK (ci.yml, deploy-supabase.yml, deploy-web.yml, keepalive.yml)`.

- [ ] **Step 7: Replace operator guide section 3**

In `docs/operator-guide.md` replace the heading line `## 3. Configure Google sign-in (pending P5)` (and any placeholder text under it up to `## 4.`) with the section below. Section 5 (IBKR Flex) stays pending.

````markdown
## 3. Configure authentication and Google sign-in (filled, P5a)

What the repository fixes: `supabase/config.toml` describes the LOCAL stack (Site URL
`http://localhost:5173`, password policy, Google block that reads `env(...)` secrets, a redirect
allow-list). `bun run check:auth-config` guards it. Production values are set in the Supabase
dashboard, as below. Apple sign-in is not used.

### 3.1 Google Cloud (once)

1. Google Cloud console, create or pick a project. APIs and Services, OAuth consent screen:
   user type External, app name, support email, add yourself as a test user (publishing the app is
   not needed for personal use; scopes are only `openid`, `userinfo.email`, `userinfo.profile`).
2. Credentials, Create credentials, OAuth client ID, application type **Web application**.
3. **Authorized JavaScript origins:** the site origin, for example `https://<domain>` (and
   `http://localhost:5173` for local testing with a separate dev client).
4. **Authorized redirect URIs:** `https://<project-ref>.supabase.co/auth/v1/callback` (this is
   Supabase's callback, not the site's). Local testing: `http://127.0.0.1:54321/auth/v1/callback`.
5. Copy the client ID and client secret. They go only into the Supabase dashboard (production) or
   `supabase/.env` (local). Never into the repository, GitHub variables read by the web build, or any
   `VITE_*` variable.

### 3.2 Supabase dashboard (production project)

1. Authentication, Sign In / Providers, **Google**: enable, paste client ID and secret, keep "Skip
   nonce check" off. (Dashboard labels may differ slightly between releases.)
2. Authentication, URL Configuration: **Site URL** `https://<domain>`. **Redirect URLs** (exact
   entries, no wildcards): `https://<domain>/auth/callback` and `https://<domain>/auth/update-password`.
   Remove any `localhost` entry from the production project.
3. Authentication, Sign In / Providers, **Email**: turn **Confirm email ON** (the committed local
   config has it off so that local sign-up needs no mail). Set the minimum password length to 10 and
   the requirement to lower case, upper case and digits (matches the web form).
4. Optional: after the intended users exist, disable new sign-ups (Authentication, Sign In /
   Providers, "Allow new users to sign up"). Every account can consume the shared email budget.
5. Test once: sign in from the deployed site with a non-default target, for example open
   `https://<domain>/portfolio` while signed out, sign in with Google, and confirm you land on
   `/portfolio`. If Supabase rejects the redirect (query string against an exact entry is UNVERIFIED)
   you land on `/` instead; that is acceptable and the allow-list stays exact.

### 3.3 Email limits and custom SMTP

- Built-in mailer: **2 messages per hour** for the whole project. One person registering and
  resetting a password can exhaust it; plan to configure custom SMTP before inviting others.
- Per user: one confirmation or reset email per 60 seconds. Per IP: 30 requests per 5 minutes for
  sign-up, sign-in, recover, resend and user endpoints; token refresh 150 per 5 minutes.
- Custom SMTP through Resend (host `smtp.resend.com`, port 465, user `resend`, password = Resend
  API key) is set up together with notifications in section 4 (P3). Supabase's default custom-SMTP
  limit is 30 messages per hour. These emails count against Resend's 100 per day.
- CAPTCHA (Cloudflare Turnstile) is not wired in the web app yet; combine the sign-up switch above
  with the rate limits until it is.

### 3.4 Local development

- `Copy-Item supabase/.env.example supabase/.env`, then `bun run supabase:start`.
- Email/password works with no mail (local confirmations are off). Reset-password emails appear in
  the local mail viewer at `http://127.0.0.1:54324`.
- Google locally needs a real OAuth client with redirect URI
  `http://127.0.0.1:54321/auth/v1/callback`, pasted into `supabase/.env`.
- Local end-to-end test: `bun run test:e2e:local` (needs the stack running; stop other dev servers).
````

Run: `bun run lint`
Expected: exit 0 (Biome ignores Markdown; the TypeScript files are formatted). If Biome reports formatting in the new `tools` files, run `bun run lint:fix` first.

- [ ] **Step 8: Commit**

```text
git add supabase/config.toml supabase/.env.example tools/lib/auth-config.ts tools/lib/auth-config.test.ts tools/check-auth-config.ts package.json docs/operator-guide.md .github/workflows/ci.yml
git commit -m "feat(auth): configure Supabase Auth locally, add config checker and operator guide section"
```

---

### Task 3: Web auth core (client, redirects, identity, errors, API, store, provider)

**Concurrency:** may run at the same time as Tasks 1 and 2. Must be merged before Tasks 4 and 5.

**Files:**
- Create (source): `apps/web/src/lib/supabase.ts` (replaces the P4 file if present; keeps its `supabase` export), `apps/web/src/features/auth/redirects.ts`, `identity.ts`, `errors.ts`, `schemas.ts`, `api.ts`, `auth-store.ts`, `auth-provider.tsx`, `default.ts`
- Create (tests and helpers): `apps/web/src/lib/supabase.test.ts`, `apps/web/src/features/auth/redirects.test.ts`, `identity.test.ts`, `errors.test.ts`, `schemas.test.ts`, `api.test.ts`, `auth-store.test.ts`, `auth-provider.test.tsx`, `apps/web/src/test/auth-fixtures.ts`, `apps/web/src/test/auth-default-mock.ts`
- Modify: `apps/web/package.json` (dependencies), `apps/web/src/vite-env.d.ts`, `apps/web/src/test/setup.ts`

**Interfaces:**
- Consumes: `queryClient` from `@/lib/query-client` (P0).
- Produces: `supabase`, `createSupabaseClient(url, anonKey)`; `safeNext(raw)`, `nextSearch(target)`, `buildCallbackUrl(origin, next?)`, `buildRecoveryUrl(origin)`; `providersOf(user)`, `hasPasswordIdentity(user)`, `isGoogleOnly(user)`; `mapAuthError(error)` and `AuthErrorCode`; zod schemas `emailSchema`, `passwordSchema`, `signInSchema`, `signUpSchema`, `resetRequestSchema`, `newPasswordSchema`, `changePasswordSchema`, `PASSWORD_POLICY_TEXT`, `fieldErrors(error)`; `createAuthApi(client, { origin })` returning `signInWithPassword`, `signUp`, `resendConfirmation`, `signInWithGoogle`, `requestPasswordReset`, `updatePassword`, `changePassword`, `signOut`, `completeCallback`, `recordAudit`, plus `AUDIT_EVENTS`, `AuthResult<T>`, `SignOutScope`; `createAuthStore(client, { onSignedOut })` with `AuthState { status, session, user, recovery }` and `AuthStore { getState, subscribe, clearRecovery, dispose }`; `AuthProvider({ store, children })` and `useAuth()`; shared `AuthSkeleton`, `AuthGate` and `TextField` components (used by Tasks 4 and 5); `authStore` and `authApi` singletons from `features/auth/default.ts`; test helpers `makeUser`, `passwordUser`, `googleUser`, `bothUser`, `makeSession`, `createFakeAuthStore`, `signedIn`, `signedOut`, `loading`, and the global mock of `default.ts` (`authApiMock`, `inertAuthStore`).

- [ ] **Step 1: Install dependencies and type the environment**

Run (PowerShell, repository root): `bun add --cwd apps/web @supabase/supabase-js@2.117.3 zod@4.6.7`
Expected: `apps/web/package.json` gains `"@supabase/supabase-js": "2.117.3"` and `"zod": "4.6.7"` in `dependencies` (P4 may already have added them; the command is then a no-op), `bun.lock` updates.

In `apps/web/src/vite-env.d.ts` make sure the interface contains these members (merge into the existing `ImportMetaEnv` if present):

```ts
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 2: Write the shared test fixtures**

`apps/web/src/test/auth-fixtures.ts`:

```ts
import type { Session, User, UserIdentity } from "@supabase/supabase-js";
import type { AuthState, AuthStore } from "@/features/auth/auth-store";

export function makeIdentity(provider: string): UserIdentity {
  return {
    id: `${provider}-id`,
    user_id: "user-1",
    identity_id: `${provider}-identity`,
    identity_data: {},
    provider,
    created_at: "2026-10-01T00:00:00Z",
    last_sign_in_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-10-01T00:00:00Z",
    email: "alice@example.test",
    email_confirmed_at: "2026-10-01T00:00:00Z",
    identities: [],
    ...overrides,
  } as User;
}

export const passwordUser = makeUser({
  identities: [makeIdentity("email")],
  app_metadata: { provider: "email", providers: ["email"] },
});

export const googleUser = makeUser({
  identities: [makeIdentity("google")],
  app_metadata: { provider: "google", providers: ["google"] },
});

export const bothUser = makeUser({
  identities: [makeIdentity("google"), makeIdentity("email")],
  app_metadata: { provider: "email", providers: ["email", "google"] },
});

export function makeSession(user: User): Session {
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user,
  } as Session;
}

export interface FakeAuthStore extends AuthStore {
  set(next: Partial<AuthState>): void;
}

export function createFakeAuthStore(initial: Partial<AuthState> = {}): FakeAuthStore {
  let state: AuthState = { status: "loading", session: null, user: null, recovery: false, ...initial };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearRecovery() {
      state = { ...state, recovery: false };
      emit();
    },
    dispose() {
      listeners.clear();
    },
    set(next) {
      state = { ...state, ...next };
      emit();
    },
  };
}

/** Initial state of the store before supabase-js has reported: status "loading". */
export const loading: Partial<AuthState> = {};

export const signedOut: Partial<AuthState> = {
  status: "signed-out",
  session: null,
  user: null,
  recovery: false,
};

export function signedIn(user: User = passwordUser, extra: Partial<AuthState> = {}): Partial<AuthState> {
  return { status: "signed-in", session: makeSession(user), user, recovery: false, ...extra };
}
```

- [ ] **Step 3: Write the tests for the client and the pure modules**

`apps/web/src/lib/supabase.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createSupabaseClient } from "./supabase";

interface AuthInternals {
  flowType: string;
  detectSessionInUrl: boolean;
  persistSession: boolean;
  autoRefreshToken: boolean;
}

describe("createSupabaseClient", () => {
  const client = createSupabaseClient("http://127.0.0.1:54321", "anon-test-key");
  const auth = client.auth as unknown as AuthInternals;

  afterAll(async () => {
    await client.auth.stopAutoRefresh();
  });

  it("uses the PKCE flow with session detection, persistence and refresh", () => {
    expect(auth.flowType).toBe("pkce");
    expect(auth.detectSessionInUrl).toBe(true);
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
  });

  it("never references a service-role key in the browser client source", () => {
    const source = readFileSync(new URL("./supabase.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/service[_-]?role|sb_secret_/i);
  });
});
```

`apps/web/src/features/auth/redirects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCallbackUrl, buildRecoveryUrl, nextSearch, safeNext } from "./redirects";

describe("safeNext", () => {
  it.each([
    ["/portfolio", "/portfolio"],
    ["/portfolio?tab=positions#top", "/portfolio?tab=positions#top"],
    ["/profile/security", "/profile/security"],
    ["/quotes?symbol=MSFT", "/quotes?symbol=MSFT"],
    ["/", "/"],
  ])("accepts the internal path %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  it.each([
    ["//evil.com"],
    ["//evil.com/path"],
    ["https://evil"],
    ["https://evil.com/portfolio"],
    ["http://localhost:5173/portfolio"],
    ["/\\evil"],
    ["\\\\evil"],
    ["/\\/evil.com"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["/%2F/evil.com"],
    ["/%5Cevil.com"],
    ["/\t/evil.com"],
    ["/\n/evil.com"],
    [" /portfolio"],
    ["portfolio"],
    [""],
    ["/%E0%A4%A"],
    [`/${"a".repeat(600)}`],
  ])("rejects %j", (raw) => {
    expect(safeNext(raw)).toBe("/");
  });

  it("returns / for undefined and null", () => {
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(null)).toBe("/");
  });

  it("never sends the user back into an auth page", () => {
    expect(safeNext("/auth/sign-in")).toBe("/");
    expect(safeNext("/auth/callback?next=/portfolio")).toBe("/");
    expect(safeNext("/author")).toBe("/author");
  });
});

describe("buildCallbackUrl", () => {
  it("omits next for the default target", () => {
    expect(buildCallbackUrl("https://app.example.com")).toBe("https://app.example.com/auth/callback");
    expect(buildCallbackUrl("https://app.example.com", "/")).toBe("https://app.example.com/auth/callback");
  });

  it("carries a validated path, percent-encoded", () => {
    expect(buildCallbackUrl("https://app.example.com", "/portfolio")).toBe(
      "https://app.example.com/auth/callback?next=%2Fportfolio",
    );
    expect(buildCallbackUrl("http://localhost:5173", "/profile/security?x=1")).toBe(
      "http://localhost:5173/auth/callback?next=%2Fprofile%2Fsecurity%3Fx%3D1",
    );
  });

  it("drops a hostile next instead of forwarding it", () => {
    for (const hostile of ["//evil.com", "https://evil.com", "/\\evil", "javascript:alert(1)"]) {
      expect(buildCallbackUrl("https://app.example.com", hostile)).toBe("https://app.example.com/auth/callback");
    }
  });

  it("refuses an origin that is not a bare http(s) origin", () => {
    for (const origin of ["", "javascript:alert(1)", "https://evil.com/path", "https://a.com?x=1", "ftp://a.com"]) {
      expect(() => buildCallbackUrl(origin, "/")).toThrow();
    }
  });
});

describe("nextSearch", () => {
  it("omits the default target", () => {
    expect(nextSearch("/")).toEqual({});
    expect(nextSearch("/portfolio")).toEqual({ next: "/portfolio" });
  });
});

describe("buildRecoveryUrl", () => {
  it("points at the update-password route", () => {
    expect(buildRecoveryUrl("https://app.example.com")).toBe("https://app.example.com/auth/update-password");
    expect(() => buildRecoveryUrl("https://app.example.com/x")).toThrow();
  });
});
```

`apps/web/src/features/auth/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bothUser, googleUser, makeIdentity, makeUser, passwordUser } from "@/test/auth-fixtures";
import { hasPasswordIdentity, isGoogleOnly, providersOf } from "./identity";

describe("identity helpers", () => {
  it.each([
    ["password-only", passwordUser, ["email"], true, false],
    ["google-only", googleUser, ["google"], false, true],
    ["both providers", bothUser, ["email", "google"], true, false],
  ] as const)("%s", (_name, user, providers, hasPassword, googleOnly) => {
    expect(providersOf(user)).toEqual(providers);
    expect(hasPasswordIdentity(user)).toBe(hasPassword);
    expect(isGoogleOnly(user)).toBe(googleOnly);
  });

  it("treats identities as authoritative over stale app_metadata", () => {
    const stale = makeUser({
      identities: [makeIdentity("google")],
      app_metadata: { provider: "google", providers: ["google", "email"] },
    });
    expect(providersOf(stale)).toEqual(["google"]);
    expect(hasPasswordIdentity(stale)).toBe(false);
    expect(isGoogleOnly(stale)).toBe(true);
  });

  it("falls back to app_metadata.providers when identities are empty", () => {
    const fallback = makeUser({ identities: [], app_metadata: { providers: ["email"] } });
    expect(providersOf(fallback)).toEqual(["email"]);
    expect(hasPasswordIdentity(fallback)).toBe(true);
    expect(isGoogleOnly(fallback)).toBe(false);
  });

  it("is neither password nor Google-only when nothing is known", () => {
    const unknown = makeUser({ identities: [], app_metadata: {} });
    expect(providersOf(unknown)).toEqual([]);
    expect(hasPasswordIdentity(unknown)).toBe(false);
    expect(isGoogleOnly(unknown)).toBe(false);
  });

  it("handles a missing user", () => {
    expect(providersOf(null)).toEqual([]);
    expect(hasPasswordIdentity(undefined)).toBe(false);
    expect(isGoogleOnly(null)).toBe(false);
  });
});
```

`apps/web/src/features/auth/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapAuthError } from "./errors";

describe("mapAuthError", () => {
  it.each([
    [{ code: "invalid_credentials", message: "Invalid login credentials", status: 400 }, "invalid_credentials"],
    [{ message: "Invalid login credentials" }, "invalid_credentials"],
    [{ code: "email_not_confirmed", message: "Email not confirmed", status: 400 }, "email_not_confirmed"],
    [{ code: "over_request_rate_limit", message: "Request rate limit reached", status: 429 }, "rate_limited"],
    [{ status: 429, message: "Too many requests" }, "rate_limited"],
    [{ code: "over_email_send_rate_limit", message: "email rate limit exceeded", status: 429 }, "email_rate_limited"],
    [{ code: "weak_password", message: "Password should contain letters" }, "weak_password"],
    [{ code: "same_password", message: "New password should be different from the old password." }, "same_password"],
    [{ code: "signup_disabled", message: "Signups not allowed" }, "signup_disabled"],
    [{ code: "captcha_failed", message: "captcha verification process failed" }, "captcha_failed"],
    [{ code: "user_already_exists", message: "User already registered" }, "account_unavailable"],
    [{ name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 }, "network"],
    [{ code: "unexpected_failure", message: "boom" }, "unknown"],
  ])("maps %j to %s", (error, code) => {
    expect(mapAuthError(error).code).toBe(code);
  });

  it("maps null and undefined to unknown", () => {
    expect(mapAuthError(null).code).toBe("unknown");
    expect(mapAuthError(undefined).code).toBe("unknown");
  });

  it("gives user-facing messages that reveal nothing about account existence", () => {
    expect(mapAuthError({ code: "invalid_credentials" }).message).toBe("Email or password is incorrect.");
    expect(mapAuthError({ code: "user_already_exists" }).message).not.toMatch(/already (registered|exists)/i);
    expect(mapAuthError({ code: "email_not_confirmed" }).message).toMatch(/confirm/i);
    expect(mapAuthError({ code: "over_request_rate_limit" }).message).toMatch(/too many/i);
  });

  it("never echoes the raw server message", () => {
    expect(mapAuthError({ code: "unexpected_failure", message: "secret internal detail" }).message).not.toMatch(
      /secret internal detail/,
    );
  });
});
```

`apps/web/src/features/auth/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  emailSchema,
  fieldErrors,
  newPasswordSchema,
  PASSWORD_POLICY_TEXT,
  passwordSchema,
  signInSchema,
  signUpSchema,
} from "./schemas";

describe("passwordSchema", () => {
  it.each([["Abcdefghi1"], ["Correct-Horse-9"], [`Aa1${"x".repeat(60)}`]])("accepts %s", (value) => {
    expect(passwordSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["short1A"],
    ["alllowercase123"],
    ["ALLUPPERCASE123"],
    ["NoDigitsHereAtAll"],
    [`Aa1${"x".repeat(80)}`],
  ])("rejects %s", (value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });
});

describe("form schemas", () => {
  it("normalises the email", () => {
    expect(emailSchema.parse("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("does not apply the password policy on sign-in", () => {
    expect(signInSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(signInSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });

  it("applies the policy on sign-up", () => {
    const result = signUpSchema.safeParse({ email: "a@b.co", password: "weak" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result.error).password).toBe(PASSWORD_POLICY_TEXT);
  });

  it("requires matching confirmation for a new password", () => {
    const result = newPasswordSchema.safeParse({ password: "Abcdefghi1", confirm: "Abcdefghi2" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result.error).confirm).toBe("The passwords do not match.");
  });

  it("requires the current password when changing it", () => {
    const result = changePasswordSchema.safeParse({ current: "", password: "Abcdefghi1", confirm: "Abcdefghi1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result.error).current).toBe("Enter your current password.");
  });
});
```

Run: `bun run test:web -- supabase redirects identity errors schemas`
Expected: FAIL (`Failed to resolve import` for each module under test).

- [ ] **Step 4: Implement the client and the pure modules**

`apps/web/src/lib/supabase.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

/**
 * Browser client. Only the public URL and the anon (publishable) key may be used here; RLS is the
 * protection. PKCE is explicit because the research does not state that it is the default
 * (spec 11.1).
 */
export function createSupabaseClient(url: string, anonKey: string) {
  return createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing ${name}. Copy apps/web/.env.example to apps/web/.env.local and fill it.`);
  }
  return value;
}

export const supabase = createSupabaseClient(
  requireEnv("VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL),
  requireEnv("VITE_SUPABASE_ANON_KEY", import.meta.env.VITE_SUPABASE_ANON_KEY),
);

export type AppSupabaseClient = typeof supabase;
```

`apps/web/src/features/auth/redirects.ts`:

```ts
const DUMMY_ORIGIN = "https://app.invalid";
const MAX_LENGTH = 512;
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** Backslash, ASCII control characters and DEL. Browsers drop tabs and newlines inside URLs. */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * The only function allowed to turn untrusted input (the `next` search parameter) into a
 * navigation target. Returns an internal path or "/". Never an absolute URL.
 */
export function safeNext(raw: string | undefined | null): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || hasForbiddenChar(raw)) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (decoded.startsWith("//") || hasForbiddenChar(decoded)) return "/";
  let url: URL;
  try {
    url = new URL(raw, DUMMY_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== DUMMY_ORIGIN) return "/";
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Search object for a link or redirect that carries `next` (omitted for the default target). */
export function nextSearch(target: string): { next?: string } {
  return target === "/" ? {} : { next: target };
}

function assertOrigin(origin: string): void {
  if (!ORIGIN_PATTERN.test(origin)) throw new Error("Invalid site origin");
}

/** OAuth and email-confirmation `redirectTo`. `next` is omitted for "/" so an exact allow-list entry matches. */
export function buildCallbackUrl(origin: string, next?: string): string {
  assertOrigin(origin);
  const target = safeNext(next);
  const base = `${origin}/auth/callback`;
  return target === "/" ? base : `${base}?next=${encodeURIComponent(target)}`;
}

/** Password-reset `redirectTo`. */
export function buildRecoveryUrl(origin: string): string {
  assertOrigin(origin);
  return `${origin}/auth/update-password`;
}
```

`apps/web/src/features/auth/identity.ts`:

```ts
import type { User } from "@supabase/supabase-js";

type IdentityUser = Pick<User, "identities" | "app_metadata"> | null | undefined;

/**
 * Providers the account can sign in with. `identities` is authoritative (spec 11.4);
 * `app_metadata.providers` is the fallback when identities are not present on the user object.
 */
export function providersOf(user: IdentityUser): string[] {
  if (!user) return [];
  const found = new Set<string>();
  const identities = user.identities ?? [];
  if (identities.length > 0) {
    for (const identity of identities) {
      if (typeof identity.provider === "string") found.add(identity.provider.toLowerCase());
    }
  } else {
    const listed: unknown = user.app_metadata?.providers;
    if (Array.isArray(listed)) {
      for (const provider of listed) {
        if (typeof provider === "string") found.add(provider.toLowerCase());
      }
    }
  }
  return [...found].sort();
}

export function hasPasswordIdentity(user: IdentityUser): boolean {
  return providersOf(user).includes("email");
}

export function isGoogleOnly(user: IdentityUser): boolean {
  const providers = providersOf(user);
  return providers.length > 0 && providers.every((provider) => provider === "google");
}
```

`apps/web/src/features/auth/errors.ts`:

```ts
export type AuthErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "rate_limited"
  | "email_rate_limited"
  | "weak_password"
  | "same_password"
  | "signup_disabled"
  | "captcha_failed"
  | "account_unavailable"
  | "callback_failed"
  | "network"
  | "unknown";

export interface AuthErrorLike {
  message?: string | undefined;
  code?: string | undefined;
  status?: number | undefined;
  name?: string | undefined;
}

const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_not_confirmed: "Your email address is not confirmed yet. Open the confirmation link we sent you, or ask for a new one.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  email_rate_limited: "Too many emails were requested. Wait before asking for another one.",
  weak_password: "The password does not meet the requirements.",
  same_password: "Choose a password that is different from the current one.",
  signup_disabled: "Sign-up is currently closed.",
  captcha_failed: "Verification failed. Reload the page and try again.",
  account_unavailable: "We could not create that account. If you already registered, sign in or reset your password.",
  callback_failed: "Sign-in could not be completed. Start again.",
  network: "Could not reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Try again.",
};

/** Maps a Supabase auth error to a fixed, user-facing message. Raw server text is never shown. */
export function mapAuthError(error: AuthErrorLike | null | undefined): { code: AuthErrorCode; message: string } {
  const code = (error?.code ?? "").toLowerCase();
  const text = (error?.message ?? "").toLowerCase();
  const pick = (value: AuthErrorCode) => ({ code: value, message: MESSAGES[value] });

  if (code === "invalid_credentials" || text.includes("invalid login credentials")) return pick("invalid_credentials");
  if (code === "email_not_confirmed" || text.includes("email not confirmed")) return pick("email_not_confirmed");
  if (code === "over_email_send_rate_limit" || text.includes("email rate limit")) return pick("email_rate_limited");
  if (code === "over_request_rate_limit" || error?.status === 429 || text.includes("rate limit")) {
    return pick("rate_limited");
  }
  if (code === "weak_password") return pick("weak_password");
  if (code === "same_password" || text.includes("different from the old password")) return pick("same_password");
  if (code === "signup_disabled") return pick("signup_disabled");
  if (code === "captcha_failed") return pick("captcha_failed");
  if (code === "user_already_exists") return pick("account_unavailable");
  if (code === "callback_failed") return pick("callback_failed");
  if (error?.name === "AuthRetryableFetchError" || text.includes("failed to fetch") || text.includes("network")) {
    return pick("network");
  }
  return pick("unknown");
}
```

`apps/web/src/features/auth/schemas.ts`:

```ts
import { z } from "zod";

export const PASSWORD_POLICY_TEXT =
  "Use at least 10 characters with a lower-case letter, an upper-case letter and a digit (at most 72).";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."));

export const passwordSchema = z
  .string()
  .min(10, PASSWORD_POLICY_TEXT)
  .max(72, PASSWORD_POLICY_TEXT)
  .regex(/[a-z]/, PASSWORD_POLICY_TEXT)
  .regex(/[A-Z]/, PASSWORD_POLICY_TEXT)
  .regex(/\d/, PASSWORD_POLICY_TEXT);

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const signUpSchema = z.object({ email: emailSchema, password: passwordSchema });

export const resetRequestSchema = z.object({ email: emailSchema });

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((value) => value.password === value.confirm, {
    path: ["confirm"],
    message: "The passwords do not match.",
  });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ["confirm"],
    message: "The passwords do not match.",
  });

/** First message per field (`form` for issues without a path). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
```

Run: `bun run test:web -- supabase redirects identity errors schemas`
Expected: all pass (about 60 cases). If the `supabase.test.ts` assertions on `flowType`/`detectSessionInUrl`/`persistSession`/`autoRefreshToken` fail because supabase-js 2.117.3 names the internal fields differently, inspect `Object.keys(client.auth)` once, adapt `AuthInternals` to the real names, and keep the four assertions (they are the PKCE pin).

- [ ] **Step 5: Write the tests for the API, the store and the provider**

`apps/web/src/features/auth/api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { bothUser, googleUser, makeSession, passwordUser } from "@/test/auth-fixtures";
import { AUDIT_EVENTS, createAuthApi } from "./api";

const ORIGIN = "https://app.example.com";

function makeClient() {
  const auth = {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    resend: vi.fn(),
    signInWithOAuth: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
    getSession: vi.fn(),
    signOut: vi.fn(),
    exchangeCodeForSession: vi.fn(),
  };
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const client = { auth, rpc } as unknown as Parameters<typeof createAuthApi>[0];
  return { auth, rpc, api: createAuthApi(client, { origin: () => ORIGIN }) };
}

describe("signInWithPassword", () => {
  it("returns the session", async () => {
    const { auth, api } = makeClient();
    const session = makeSession(passwordUser);
    auth.signInWithPassword.mockResolvedValue({ data: { session }, error: null });
    expect(await api.signInWithPassword("a@b.co", "pw")).toEqual({ ok: true, data: session });
  });

  it("maps invalid credentials to the fixed message", async () => {
    const { auth, api } = makeClient();
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials", status: 400 },
    });
    expect(await api.signInWithPassword("a@b.co", "pw")).toEqual({
      ok: false,
      code: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
  });
});

describe("signUp", () => {
  it("sets emailRedirectTo to the callback and drops a hostile next", async () => {
    const { auth, api } = makeClient();
    auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const result = await api.signUp("a@b.co", "Abcdefghi1", "https://evil.com");
    expect(result).toEqual({ ok: true, data: { session: null } });
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "a@b.co",
      password: "Abcdefghi1",
      options: { emailRedirectTo: `${ORIGIN}/auth/callback` },
    });
  });

  it("returns the session when the project auto-confirms", async () => {
    const { auth, api } = makeClient();
    const session = makeSession(passwordUser);
    auth.signUp.mockResolvedValue({ data: { session }, error: null });
    expect(await api.signUp("a@b.co", "Abcdefghi1", "/portfolio")).toEqual({ ok: true, data: { session } });
    expect(auth.signUp.mock.calls[0]?.[0].options.emailRedirectTo).toBe(`${ORIGIN}/auth/callback?next=%2Fportfolio`);
  });
});

describe("signInWithGoogle", () => {
  it("requests the google provider with a validated redirect", async () => {
    const { auth, api } = makeClient();
    auth.signInWithOAuth.mockResolvedValue({ data: {}, error: null });
    await api.signInWithGoogle("/portfolio");
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: `${ORIGIN}/auth/callback?next=%2Fportfolio` },
    });
    await api.signInWithGoogle("//evil.com");
    expect(auth.signInWithOAuth.mock.calls[1]?.[0].options.redirectTo).toBe(`${ORIGIN}/auth/callback`);
  });
});

describe("requestPasswordReset", () => {
  it("uses the update-password route as redirect", async () => {
    const { auth, api } = makeClient();
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    expect(await api.requestPasswordReset("a@b.co")).toEqual({ ok: true, data: undefined });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("a@b.co", {
      redirectTo: `${ORIGIN}/auth/update-password`,
    });
  });

  it("swallows errors that would reveal whether the account exists but surfaces rate limits", async () => {
    const { auth, api } = makeClient();
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: { code: "user_not_found", message: "x" } });
    expect((await api.requestPasswordReset("a@b.co")).ok).toBe(true);
    auth.resetPasswordForEmail.mockResolvedValueOnce({
      data: {},
      error: { code: "over_email_send_rate_limit", message: "email rate limit exceeded", status: 429 },
    });
    const limited = await api.requestPasswordReset("a@b.co");
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.code).toBe("email_rate_limited");
  });
});

describe("updatePassword", () => {
  it("records the password change and no method change when providers are unchanged", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: passwordUser }, error: null });
    expect(await api.updatePassword("Abcdefghi1", "recovery")).toEqual({ ok: true, data: undefined });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "Abcdefghi1" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_audit", {
      p_type: AUDIT_EVENTS.passwordChanged,
      p_meta: { via: "recovery" },
    });
  });

  it("also records a sign-in method change when the provider set changes", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(googleUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: bothUser }, error: null });
    await api.updatePassword("Abcdefghi1", "recovery");
    expect(rpc).toHaveBeenCalledWith("record_audit", {
      p_type: AUDIT_EVENTS.methodChanged,
      p_meta: { from: ["google"], to: ["email", "google"] },
    });
  });

  it("does not fail the update when the audit write fails", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: passwordUser }, error: null });
    rpc.mockResolvedValue({ error: { code: "54000", message: "audit rate limit reached" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await api.updatePassword("Abcdefghi1")).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith("audit write failed", "54000");
    warn.mockRestore();
  });

  it("maps a rejected password", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: null }, error: { code: "same_password", message: "x" } });
    const result = await api.updatePassword("Abcdefghi1");
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("changePassword", () => {
  it("verifies the current password before updating", async () => {
    const { auth, api } = makeClient();
    auth.signInWithPassword.mockResolvedValue({ data: { session: makeSession(passwordUser) }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: passwordUser }, error: null });
    expect((await api.changePassword("alice@example.test", "Old-Passw0rd-1", "New-Passw0rd-2")).ok).toBe(true);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "alice@example.test", password: "Old-Passw0rd-1" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "New-Passw0rd-2" });
  });

  it("stops with a clear message when the current password is wrong", async () => {
    const { auth, api } = makeClient();
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials", status: 400 },
    });
    const result = await api.changePassword("alice@example.test", "wrong", "New-Passw0rd-2");
    expect(result).toEqual({ ok: false, code: "invalid_credentials", message: "The current password is incorrect." });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("records sign-out-everywhere before calling signOut", async () => {
    const { auth, rpc, api } = makeClient();
    auth.signOut.mockResolvedValue({ error: null });
    expect((await api.signOut("global")).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("record_audit", { p_type: AUDIT_EVENTS.signOutAll, p_meta: { scope: "global" } });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(auth.signOut.mock.invocationCallOrder[0] ?? 0);
  });

  it("does not audit a local sign-out", async () => {
    const { auth, rpc, api } = makeClient();
    auth.signOut.mockResolvedValue({ error: null });
    await api.signOut("local");
    expect(rpc).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("completeCallback", () => {
  it("accepts the session supabase-js already established from the URL", async () => {
    const { auth, api } = makeClient();
    const session = makeSession(passwordUser);
    auth.getSession.mockResolvedValue({ data: { session } });
    expect(await api.completeCallback("abc")).toEqual({ ok: true, data: session });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges the code once even when called twice (StrictMode double effect)", async () => {
    const { auth, api } = makeClient();
    const session = makeSession(passwordUser);
    auth.getSession.mockResolvedValue({ data: { session: null } });
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session }, error: null });
    const [first, second] = await Promise.all([api.completeCallback("abc"), api.completeCallback("abc")]);
    expect(first).toEqual({ ok: true, data: session });
    expect(second).toEqual(first);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
  });

  it("fails cleanly without a code or when the exchange is rejected", async () => {
    const { auth, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: null } });
    const missing = await api.completeCallback(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("callback_failed");
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: { code: "flow_state_not_found", message: "invalid flow state" },
    });
    expect((await api.completeCallback("expired")).ok).toBe(false);
  });
});

describe("recordAudit", () => {
  it("sends only the type and the metadata", async () => {
    const { rpc, api } = makeClient();
    await api.recordAudit(AUDIT_EVENTS.passwordChanged, { via: "profile" });
    expect(rpc).toHaveBeenCalledWith("record_audit", { p_type: "auth.password_changed", p_meta: { via: "profile" } });
  });
});
```

`apps/web/src/features/auth/auth-store.test.ts`:

```ts
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { makeSession, passwordUser } from "@/test/auth-fixtures";
import { createAuthStore } from "./auth-store";

function makeFakeClient(initial: Session | null, emitInitial = true) {
  let listener: ((event: AuthChangeEvent, session: Session | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const client = {
    auth: {
      onAuthStateChange: vi.fn((callback: (event: AuthChangeEvent, session: Session | null) => void) => {
        listener = callback;
        if (emitInitial) queueMicrotask(() => callback("INITIAL_SESSION", initial));
        return { data: { subscription: { unsubscribe } } };
      }),
      getSession: vi.fn(async () => ({ data: { session: initial }, error: null })),
    },
  } as unknown as Parameters<typeof createAuthStore>[0];
  return { client, unsubscribe, emit: (event: AuthChangeEvent, session: Session | null) => listener?.(event, session) };
}

const session = makeSession(passwordUser);

describe("createAuthStore", () => {
  it("starts in loading and resolves to signed-in", async () => {
    const { client } = makeFakeClient(session);
    const store = createAuthStore(client);
    expect(store.getState().status).toBe("loading");
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-in"));
    expect(store.getState().user?.id).toBe("user-1");
    expect(store.getState().recovery).toBe(false);
  });

  it("resolves to signed-out without a session and does not report a sign-out", async () => {
    const onSignedOut = vi.fn();
    const { client } = makeFakeClient(null);
    const store = createAuthStore(client, { onSignedOut });
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-out"));
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("falls back to getSession when INITIAL_SESSION is never emitted", async () => {
    const { client } = makeFakeClient(session, false);
    const store = createAuthStore(client);
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-in"));
  });

  it("holds the recovery flag in memory only and keeps it across token refreshes", async () => {
    const { client, emit } = makeFakeClient(null);
    const store = createAuthStore(client);
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-out"));
    emit("PASSWORD_RECOVERY", session);
    expect(store.getState()).toMatchObject({ status: "signed-in", recovery: true });
    emit("TOKEN_REFRESHED", session);
    expect(store.getState().recovery).toBe(true);
    store.clearRecovery();
    expect(store.getState()).toMatchObject({ status: "signed-in", recovery: false });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("clears recovery and notifies on SIGNED_OUT", async () => {
    const onSignedOut = vi.fn();
    const { client, emit } = makeFakeClient(session);
    const store = createAuthStore(client, { onSignedOut });
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-in"));
    emit("PASSWORD_RECOVERY", session);
    emit("SIGNED_OUT", null);
    expect(store.getState()).toMatchObject({ status: "signed-out", user: null, session: null, recovery: false });
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers, supports unsubscribe, and dispose detaches from supabase", async () => {
    const { client, emit, unsubscribe } = makeFakeClient(null);
    const store = createAuthStore(client);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-out"));
    const callsAfterInit = listener.mock.calls.length;
    emit("SIGNED_IN", session);
    expect(listener.mock.calls.length).toBe(callsAfterInit + 1);
    stop();
    emit("SIGNED_OUT", null);
    expect(listener.mock.calls.length).toBe(callsAfterInit + 1);
    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

`apps/web/src/features/auth/auth-provider.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeAuthStore, googleUser, signedIn, signedOut } from "@/test/auth-fixtures";
import { AuthProvider, useAuth } from "./auth-provider";

function Probe() {
  const { status, user, recovery } = useAuth();
  return (
    <p data-testid="probe">
      {status}|{user?.id ?? "none"}|{recovery ? "recovery" : "normal"}
    </p>
  );
}

describe("AuthProvider", () => {
  it("exposes status, user and the recovery flag and follows store updates", () => {
    const store = createFakeAuthStore();
    render(
      <AuthProvider store={store}>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("loading|none|normal");
    act(() => store.set(signedIn(googleUser, { recovery: true })));
    expect(screen.getByTestId("probe").textContent).toBe("signed-in|user-1|recovery");
    act(() => store.set(signedOut));
    expect(screen.getByTestId("probe").textContent).toBe("signed-out|none|normal");
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
  });
});
```

Run: `bun run test:web -- api auth-store auth-provider`
Expected: FAIL (`Failed to resolve import "./api"` and the others).

- [ ] **Step 6: Implement the API, the store, the provider and the defaults**

`apps/web/src/features/auth/api.ts`:

```ts
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { type AuthErrorCode, type AuthErrorLike, mapAuthError } from "./errors";
import { providersOf } from "./identity";
import { buildCallbackUrl, buildRecoveryUrl } from "./redirects";

type AuthClient = Pick<SupabaseClient, "auth" | "rpc">;

export interface AuthFailure {
  ok: false;
  code: AuthErrorCode;
  message: string;
}
export type AuthResult<T> = { ok: true; data: T } | AuthFailure;
export type SignOutScope = "local" | "global" | "others";

export const AUDIT_EVENTS = {
  passwordChanged: "auth.password_changed",
  methodChanged: "auth.method_changed",
  signOutAll: "auth.sign_out_all",
} as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

export interface AuthApiOptions {
  /** The origin that holds the PKCE verifier: always the current browser origin. */
  origin: () => string;
}

const OK: AuthResult<undefined> = { ok: true, data: undefined };

function failure(error: AuthErrorLike | null | undefined): AuthFailure {
  const mapped = mapAuthError(error);
  return { ok: false, code: mapped.code, message: mapped.message };
}

export function createAuthApi(client: AuthClient, options: AuthApiOptions) {
  const callbackRuns = new Map<string, Promise<AuthResult<Session>>>();

  /** Writes an audit row through the RPC. Never throws; logs only the error code. */
  async function recordAudit(type: AuditEventType, meta: Record<string, unknown> = {}): Promise<AuthResult<undefined>> {
    try {
      const { error } = await client.rpc("record_audit", { p_type: type, p_meta: meta });
      if (error) {
        console.warn("audit write failed", error.code);
        return failure(error);
      }
      return OK;
    } catch {
      console.warn("audit write failed", "exception");
      return failure(null);
    }
  }

  async function signInWithPassword(email: string, password: string): Promise<AuthResult<Session>> {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return failure(error ?? { code: "invalid_credentials" });
    return { ok: true, data: data.session };
  }

  async function signUp(email: string, password: string, next?: string): Promise<AuthResult<{ session: Session | null }>> {
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: buildCallbackUrl(options.origin(), next) },
    });
    if (error) return failure(error);
    return { ok: true, data: { session: data.session } };
  }

  async function resendConfirmation(email: string, next?: string): Promise<AuthResult<undefined>> {
    const { error } = await client.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: buildCallbackUrl(options.origin(), next) },
    });
    return error ? failure(error) : OK;
  }

  async function signInWithGoogle(next?: string): Promise<AuthResult<undefined>> {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: buildCallbackUrl(options.origin(), next) },
    });
    return error ? failure(error) : OK;
  }

  async function requestPasswordReset(email: string): Promise<AuthResult<undefined>> {
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: buildRecoveryUrl(options.origin()) });
    if (error) {
      const failed = failure(error);
      // Anything else could reveal whether the address has an account.
      const surfaced: AuthErrorCode[] = ["rate_limited", "email_rate_limited", "network", "captcha_failed"];
      if (surfaced.includes(failed.code)) return failed;
    }
    return OK;
  }

  async function updatePassword(newPassword: string, via: "recovery" | "profile" = "recovery"): Promise<AuthResult<undefined>> {
    const { data: current } = await client.auth.getSession();
    const before = providersOf(current.session?.user);
    const { data, error } = await client.auth.updateUser({ password: newPassword });
    if (error) return failure(error);
    await recordAudit(AUDIT_EVENTS.passwordChanged, { via });
    const after = providersOf(data.user);
    if (before.join(",") !== after.join(",")) {
      await recordAudit(AUDIT_EVENTS.methodChanged, { from: before, to: after });
    }
    return OK;
  }

  /** Profile password change: verifies the current password first (spec 11.3), then updates. */
  async function changePassword(email: string, currentPassword: string, newPassword: string): Promise<AuthResult<undefined>> {
    const verified = await client.auth.signInWithPassword({ email, password: currentPassword });
    if (verified.error) {
      const failed = failure(verified.error);
      return failed.code === "invalid_credentials"
        ? { ok: false, code: "invalid_credentials", message: "The current password is incorrect." }
        : failed;
    }
    return updatePassword(newPassword, "profile");
  }

  async function signOut(scope: SignOutScope): Promise<AuthResult<undefined>> {
    if (scope !== "local") await recordAudit(AUDIT_EVENTS.signOutAll, { scope });
    const { error } = await client.auth.signOut({ scope });
    return error ? failure(error) : OK;
  }

  /**
   * Finishes /auth/callback. supabase-js (detectSessionInUrl) may already have exchanged the
   * single-use code while initialising, and getSession() waits for that; the explicit exchange is
   * only the fallback. Runs for the same code are shared (React StrictMode runs effects twice).
   */
  function completeCallback(code: string | undefined): Promise<AuthResult<Session>> {
    if (code) {
      const existing = callbackRuns.get(code);
      if (existing) return existing;
    }
    const run = (async (): Promise<AuthResult<Session>> => {
      const { data } = await client.auth.getSession();
      if (data.session) return { ok: true, data: data.session };
      if (!code) return failure({ code: "callback_failed" });
      const exchanged = await client.auth.exchangeCodeForSession(code);
      if (exchanged.error || !exchanged.data.session) return failure(exchanged.error ?? { code: "callback_failed" });
      return { ok: true, data: exchanged.data.session };
    })();
    if (code) callbackRuns.set(code, run);
    return run;
  }

  return {
    signInWithPassword,
    signUp,
    resendConfirmation,
    signInWithGoogle,
    requestPasswordReset,
    updatePassword,
    changePassword,
    signOut,
    completeCallback,
    recordAudit,
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
```

`apps/web/src/features/auth/auth-store.ts`:

```ts
import type { AuthChangeEvent, Session, SupabaseClient, User } from "@supabase/supabase-js";

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  /** True after a PASSWORD_RECOVERY event until the password is set. Memory only. */
  recovery: boolean;
}

export interface AuthStore {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  clearRecovery(): void;
  dispose(): void;
}

export interface AuthStoreOptions {
  onSignedOut?: () => void;
}

type AuthClient = Pick<SupabaseClient, "auth">;

const LOADING: AuthState = { status: "loading", session: null, user: null, recovery: false };

export function createAuthStore(client: AuthClient, options: AuthStoreOptions = {}): AuthStore {
  let state: AuthState = LOADING;
  const listeners = new Set<() => void>();

  const set = (next: AuthState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  // No other supabase-js call is made inside this callback (they can deadlock the auth lock).
  const apply = (event: AuthChangeEvent, session: Session | null) => {
    if (event === "SIGNED_OUT" || session === null) {
      set({ status: "signed-out", session: null, user: null, recovery: false });
      if (event === "SIGNED_OUT") options.onSignedOut?.();
      return;
    }
    set({
      status: "signed-in",
      session,
      user: session.user,
      recovery: event === "PASSWORD_RECOVERY" ? true : state.recovery,
    });
  };

  const { data } = client.auth.onAuthStateChange((event, session) => apply(event, session));

  // Safety net: if INITIAL_SESSION is never delivered the app must not stay in "loading".
  void client.auth
    .getSession()
    .then(({ data: { session } }) => {
      if (state.status === "loading") apply("INITIAL_SESSION", session);
    })
    .catch(() => {
      if (state.status === "loading") apply("INITIAL_SESSION", null);
    });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearRecovery() {
      if (state.recovery) set({ ...state, recovery: false });
    },
    dispose() {
      data.subscription.unsubscribe();
      listeners.clear();
    },
  };
}
```

`apps/web/src/features/auth/auth-provider.tsx`:

```tsx
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { AuthState, AuthStore } from "./auth-store";

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ store, children }: { store: AuthStore; children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
```

`apps/web/src/features/auth/default.ts` (the only module that wires the real client; Vitest replaces it globally, see Step 7):

```ts
import { queryClient } from "@/lib/query-client";
import { supabase } from "@/lib/supabase";
import { createAuthApi } from "./api";
import { createAuthStore } from "./auth-store";

export const authStore = createAuthStore(supabase, { onSignedOut: () => queryClient.clear() });

// The PKCE verifier lives in this origin's storage, so the callback must return to this origin.
export const authApi = createAuthApi(supabase, { origin: () => window.location.origin });
```

Shared UI pieces used by both the auth pages (Task 4) and the profile pages (Task 5); they depend only on `useAuth` and the P0 shadcn components. Their behaviour is pinned by the `AuthGate` tests in Task 4 and the form tests in Tasks 4 and 5.

`apps/web/src/features/auth/components/auth-skeleton.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

/** Neutral placeholder; deliberately shows nothing about the page it stands in for. */
export function AuthSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" data-testid="auth-skeleton" className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full max-w-xl" />
      <Skeleton className="h-32 w-full max-w-xl" />
    </div>
  );
}
```

`apps/web/src/features/auth/components/auth-gate.tsx`:

```tsx
import type { ReactNode } from "react";
import { useAuth } from "../auth-provider";
import { AuthSkeleton } from "./auth-skeleton";

/** Renders children only for a signed-in user that is not in password recovery. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, recovery } = useAuth();
  if (status !== "signed-in" || recovery) return <AuthSkeleton />;
  return <>{children}</>;
}
```

`apps/web/src/features/auth/components/text-field.tsx`:

```tsx
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  hint?: string;
  error?: string | undefined;
  disabled?: boolean;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  hint,
  error,
  disabled,
}: TextFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        disabled={disabled}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

Run: `bun run test:web -- api auth-store auth-provider`
Expected: all pass (about 31 cases).

- [ ] **Step 7: Install the global test mock of `default.ts`, then verify**

`apps/web/src/test/auth-default-mock.ts` (components import `authApi`/`authStore` from `@/features/auth/default`; in tests they receive these objects):

```ts
import { vi } from "vitest";
import type { AuthApi } from "@/features/auth/api";
import type { AuthStore } from "@/features/auth/auth-store";

export const authApiMock = {
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  resendConfirmation: vi.fn(),
  signInWithGoogle: vi.fn(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
  completeCallback: vi.fn(),
  recordAudit: vi.fn(),
} satisfies Record<keyof AuthApi, unknown>;

/** Never resolves out of "loading"; tests that need state pass their own fake store to the router. */
export const inertAuthStore: AuthStore = {
  getState: () => ({ status: "loading", session: null, user: null, recovery: false }),
  subscribe: () => () => undefined,
  clearRecovery: () => undefined,
  dispose: () => undefined,
};

export const authDefaultMock = { authApi: authApiMock, authStore: inertAuthStore };
```

Replace `apps/web/src/test/setup.ts` (P0 version plus the env stubs, the global mock and mock resets):

```ts
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// supabase.ts reads these at import time; the values are dummies and no request is made.
vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");

// The real default.ts would start a Supabase client (timers, storage) in every test file that imports
// the router. A vi.mock in a setup file applies to every test file.
vi.mock("@/features/auth/default", async () => (await import("./auth-default-mock")).authDefaultMock);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});
```

Run: `bun run test:web`
Expected: every web test passes (the P0 tests plus the new ones). If a test file still starts a real Supabase client (a timer warning or a `Missing VITE_SUPABASE_URL` error), the global mock did not apply: add `vi.mock("@/features/auth/default", async () => (await import("@/test/auth-default-mock")).authDefaultMock);` at the top of that file and note it in the results file.

Run: `bun run lint:fix` then `bun run lint` and `bun run typecheck`
Expected: exit 0. Typical fixes: wrap long lines the formatter leaves, replace `as` casts only where a type guard is simple, never add `any`.

- [ ] **Step 8: Commit**

```text
git add apps/web/package.json bun.lock apps/web/src/lib apps/web/src/features/auth apps/web/src/test apps/web/src/vite-env.d.ts
git commit -m "feat(web): add Supabase PKCE client, redirect validation, identity helpers, auth API and store"
```

---

### Task 4: Auth routes, guards, navigation and cache rules

**Concurrency:** starts after Task 3 is merged. Runs at the same time as Task 5 Steps 1 to 6 (disjoint files). Task 5 Step 7 waits for this task.

**REQUIRED before Step 4 (components and pages):** the implementer MUST load the `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills (Skill tool) and apply them to the auth pages. The code below is a complete, working baseline; the skills may refine layout, spacing, typography and copy styling. Fixed constraints: keep every label, heading, button name, `role`, `id` and `data-testid` used by the tests; shadcn components and the P0 tokens only; no colour-only status (errors carry text and `role="alert"`); 16 px gutters and a usable layout at phone width; visible focus rings; no external fonts or scripts (CSP).

**Files:**
- Create: `apps/web/src/features/auth/guards.ts`, `callback-params.ts`, `use-next-param.ts`, `use-redirect-when-signed-in.ts`
- Create: `apps/web/src/features/auth/components/auth-card.tsx`
- Create: `apps/web/src/features/auth/pages/sign-in-page.tsx`, `sign-up-page.tsx`, `callback-page.tsx`, `reset-page.tsx`, `update-password-page.tsx`, `signed-out-page.tsx`
- Create: `apps/web/src/components/user-menu.tsx`, `auth-route-sync.tsx`
- Create tests: `apps/web/src/test/render-app.tsx`, `features/auth/callback-params.test.ts`, `guards.test.tsx`, `pages/sign-in-page.test.tsx`, `pages/sign-up-page.test.tsx`, `pages/callback-page.test.tsx`, `pages/reset-page.test.tsx`, `pages/update-password-page.test.tsx`, `components/user-menu.test.tsx`, `src/auth-routes-cache.test.ts`
- Modify: `apps/web/src/router.tsx`, `src/providers.tsx`, `src/components/app-shell.tsx`, `src/components/app-shell.test.tsx` (replaced), `src/features/pages.tsx` (remove `AuthPage`), `apps/web/public/_headers`

**Interfaces:**
- Consumes: Task 3 (`AuthStore`, `AuthProvider`, `useAuth`, `authApi`, `authStore`, `safeNext`, `nextSearch`, schemas, fixtures, global mock of `default.ts`, and the shared `AuthGate`, `AuthSkeleton`, `TextField` components), P0 `isNavigationFallbackAllowed` and `isNeverCached` from `src/sw-routes.ts`.
- Produces: `requireAuth({ context, location })` for `beforeLoad`; `AuthCard`; `RouterContext { auth: AuthStore }`; `createAppRouter(history?, auth?)` (second parameter defaults to the real store); `AppProviders({ children, queryClient?, authStore? })`; routes `/auth/sign-in`, `/auth/sign-up`, `/auth/callback`, `/auth/reset`, `/auth/forgot` (redirect), `/auth/update-password`, `/auth/signed-out`; guarded `/portfolio`, `/analytics`, `/profile` (+ children); `UserMenu`, `AuthRouteSync`; test helper `renderApp(path, initialState?)` returning `{ router, store, queryClient }`.

- [ ] **Step 1: Write the test helper and the guard tests**

`apps/web/src/test/render-app.tsx`:

```tsx
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AuthState } from "@/features/auth/auth-store";
import { AppProviders } from "@/providers";
import { createAppRouter } from "@/router";
import { createFakeAuthStore, signedOut } from "./auth-fixtures";

export async function renderApp(path: string, initial: Partial<AuthState> = signedOut) {
  const store = createFakeAuthStore(initial);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }), store);
  await router.load();
  render(
    <AppProviders authStore={store} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, store, queryClient };
}

export function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Submits the form that contains the named button (a click on a submit button is not reliable in happy-dom). */
export function submit(buttonName: string) {
  const form = screen.getByRole("button", { name: buttonName }).closest("form");
  if (form === null) throw new Error(`Button "${buttonName}" is not inside a form`);
  fireEvent.submit(form);
}
```

`apps/web/src/features/auth/guards.test.tsx`:

```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeAuthStore, loading, passwordUser, signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { AuthProvider } from "./auth-provider";
import { AuthGate } from "./components/auth-gate";

describe("requireAuth", () => {
  it.each([
    ["/portfolio", "/portfolio"],
    ["/analytics", "/analytics"],
    ["/profile/security", "/profile/security"],
    ["/profile", "/profile"],
    ["/portfolio?tab=positions", "/portfolio?tab=positions"],
  ])("signed-out visit to %s goes to sign-in with next", async (path, next) => {
    const { router } = await renderApp(path, signedOut);
    expect(router.state.location.pathname).toBe("/auth/sign-in");
    expect(router.state.location.search).toEqual({ next });
  });

  it("serialises the target the way the e2e test expects", async () => {
    const { router } = await renderApp("/portfolio", signedOut);
    expect(router.state.location.href).toBe("/auth/sign-in?next=%2Fportfolio");
  });

  it("lets a signed-in user through", async () => {
    const { router } = await renderApp("/portfolio", signedIn());
    expect(router.state.location.pathname).toBe("/portfolio");
    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeTruthy();
  });

  it("keeps public routes open", async () => {
    for (const path of ["/", "/quotes", "/about", "/auth/sign-in", "/auth/sign-up", "/auth/reset"]) {
      const { router } = await renderApp(path, signedOut);
      expect(router.state.location.pathname).toBe(path);
    }
  });

  it("renders a skeleton and no protected content while auth state is loading", async () => {
    const { router } = await renderApp("/portfolio", loading);
    expect(router.state.location.pathname).toBe("/portfolio");
    expect(screen.getByTestId("auth-skeleton")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Portfolio" })).toBeNull();
  });

  it("redirects when loading resolves to signed-out", async () => {
    const { router, store } = await renderApp("/portfolio", loading);
    act(() => store.set(signedOut));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/sign-in"));
    expect(router.state.location.search).toEqual({ next: "/portfolio" });
    expect(screen.queryByRole("heading", { name: "Portfolio" })).toBeNull();
  });

  it("shows the page when loading resolves to signed-in", async () => {
    const { store } = await renderApp("/portfolio", loading);
    act(() => store.set(signedIn()));
    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeTruthy();
    expect(screen.queryByTestId("auth-skeleton")).toBeNull();
  });

  it("sends a signed-out transition on a protected page to sign-in", async () => {
    const { router, store } = await renderApp("/analytics", signedIn());
    act(() => store.set(signedOut));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/sign-in"));
    expect(router.state.location.search).toEqual({ next: "/analytics" });
  });

  it("keeps a password-recovery session away from protected routes", async () => {
    const { router } = await renderApp("/portfolio", signedIn(passwordUser, { recovery: true }));
    expect(router.state.location.pathname).toBe("/auth/update-password");
    expect(screen.queryByRole("heading", { name: "Portfolio" })).toBeNull();
  });
});

describe("AuthGate", () => {
  function renderGate(state: Parameters<typeof createFakeAuthStore>[0]) {
    const store = createFakeAuthStore(state);
    render(
      <AuthProvider store={store}>
        <AuthGate>
          <p>protected content</p>
        </AuthGate>
      </AuthProvider>,
    );
  }

  it.each([
    ["loading", loading],
    ["signed-out", signedOut],
    ["recovery session", signedIn(passwordUser, { recovery: true })],
  ])("never renders its children while %s", (_name, state) => {
    renderGate(state);
    expect(screen.queryByText("protected content")).toBeNull();
    expect(screen.getByTestId("auth-skeleton")).toBeTruthy();
  });

  it("renders its children for a signed-in user", () => {
    renderGate(signedIn());
    expect(screen.getByText("protected content")).toBeTruthy();
  });
});
```

`apps/web/src/features/auth/callback-params.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeCallbackError, parseCallbackSearch, readHashError } from "./callback-params";

describe("parseCallbackSearch", () => {
  it("keeps only known string parameters", () => {
    expect(parseCallbackSearch({ code: "abc", next: "/portfolio", error: "access_denied", other: "x" })).toEqual({
      code: "abc",
      next: "/portfolio",
      error: "access_denied",
    });
  });

  it("drops non-strings and oversize values", () => {
    expect(parseCallbackSearch({ code: 12345, next: { a: 1 }, error: "e".repeat(5000) })).toEqual({});
  });
});

describe("readHashError", () => {
  it("reads an error from the URL fragment", () => {
    expect(readHashError("#error=access_denied&error_code=x")).toBe("access_denied");
    expect(readHashError("")).toBeUndefined();
    expect(readHashError("#access_token=secret")).toBeUndefined();
  });
});

describe("describeCallbackError", () => {
  it("maps known OAuth errors to fixed messages", () => {
    expect(describeCallbackError("access_denied")).toMatch(/cancelled/i);
    expect(describeCallbackError("server_error")).toMatch(/problem/i);
    expect(describeCallbackError("temporarily_unavailable")).toMatch(/problem/i);
  });

  it("never echoes unknown or hostile values", () => {
    const message = describeCallbackError("<img src=x onerror=alert(1)>");
    expect(message).toBe("Sign-in could not be completed. Start again.");
    expect(describeCallbackError("totally_new_error")).toBe("Sign-in could not be completed. Start again.");
  });
});
```

Run: `bun run test:web -- guards callback-params`
Expected: FAIL (`Failed to resolve import`).

- [ ] **Step 2: Write the page and navigation tests**

`apps/web/src/features/auth/pages/sign-in-page.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { makeSession, passwordUser, signedIn, signedOut } from "@/test/auth-fixtures";
import { fill, renderApp, submit } from "@/test/render-app";

describe("sign-in page", () => {
  it("shows field errors and does not call the API for an invalid form", async () => {
    await renderApp("/auth/sign-in");
    submit("Sign in");
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getByText("Enter your password.")).toBeTruthy();
    expect(authApi.signInWithPassword).not.toHaveBeenCalled();
  });

  it("signs in and then follows a validated next target", async () => {
    vi.mocked(authApi.signInWithPassword).mockResolvedValue({ ok: true, data: makeSession(passwordUser) });
    const { router, store } = await renderApp("/auth/sign-in?next=%2Fportfolio");
    fill("Email", "Alice@Example.test");
    fill("Password", "whatever");
    submit("Sign in");
    await waitFor(() => expect(authApi.signInWithPassword).toHaveBeenCalledWith("alice@example.test", "whatever"));
    act(() => store.set(signedIn()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/portfolio"));
  });

  it.each([
    ["https%3A%2F%2Fevil.com"],
    ["%2F%2Fevil.com"],
    ["%2F%5Cevil.com"],
    ["javascript%3Aalert(1)"],
  ])("never leaves the app for the hostile next %s", async (hostile) => {
    const { router, store } = await renderApp(`/auth/sign-in?next=${hostile}`);
    act(() => store.set(signedIn()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(window.location.hostname).not.toMatch(/evil/);
  });

  it("redirects an already signed-in visitor to the target", async () => {
    const { router } = await renderApp("/auth/sign-in?next=%2Fprofile%2Fsecurity", signedIn());
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile/security"));
  });

  it("shows the mapped error without revealing which field was wrong", async () => {
    vi.mocked(authApi.signInWithPassword).mockResolvedValue({
      ok: false,
      code: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
    await renderApp("/auth/sign-in");
    fill("Email", "a@b.co");
    fill("Password", "nope");
    submit("Sign in");
    expect(await screen.findByText("Email or password is incorrect.")).toBeTruthy();
  });

  it("offers to resend the confirmation email for an unconfirmed account", async () => {
    vi.mocked(authApi.signInWithPassword).mockResolvedValue({
      ok: false,
      code: "email_not_confirmed",
      message: "Your email address is not confirmed yet.",
    });
    vi.mocked(authApi.resendConfirmation).mockResolvedValue({ ok: true, data: undefined });
    await renderApp("/auth/sign-in?next=%2Fportfolio");
    fill("Email", "a@b.co");
    fill("Password", "pw");
    submit("Sign in");
    const resend = await screen.findByRole("button", { name: "Resend confirmation email" });
    fireEvent.click(resend);
    await waitFor(() => expect(authApi.resendConfirmation).toHaveBeenCalledWith("a@b.co", "/portfolio"));
    expect(await screen.findByText(/new confirmation email is on its way/i)).toBeTruthy();
  });

  it("starts Google sign-in with a validated target", async () => {
    vi.mocked(authApi.signInWithGoogle).mockResolvedValue({ ok: true, data: undefined });
    await renderApp("/auth/sign-in?next=%2Fportfolio");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(authApi.signInWithGoogle).toHaveBeenCalledWith("/portfolio"));
  });

  it("falls back to / for a hostile target on the Google button", async () => {
    vi.mocked(authApi.signInWithGoogle).mockResolvedValue({ ok: true, data: undefined });
    await renderApp("/auth/sign-in?next=https%3A%2F%2Fevil.com");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(authApi.signInWithGoogle).toHaveBeenCalledWith("/"));
  });

  it("links to sign-up and password reset and keeps the target", async () => {
    await renderApp("/auth/sign-in?next=%2Fportfolio", signedOut);
    expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe(
      "/auth/sign-up?next=%2Fportfolio",
    );
    expect(screen.getByRole("link", { name: "Forgot your password?" }).getAttribute("href")).toBe("/auth/reset");
  });
});
```

`apps/web/src/features/auth/pages/sign-up-page.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { makeSession, passwordUser, signedIn } from "@/test/auth-fixtures";
import { fill, renderApp, submit } from "@/test/render-app";

describe("sign-up page", () => {
  it("shows the password policy", async () => {
    await renderApp("/auth/sign-up");
    expect(screen.getByText(/at least 10 characters/i)).toBeTruthy();
  });

  it("blocks a weak password and an invalid email before calling the API", async () => {
    await renderApp("/auth/sign-up");
    fill("Email", "not-an-email");
    fill("Password", "short");
    submit("Create account");
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getAllByText(/at least 10 characters/i).length).toBeGreaterThan(1);
    expect(authApi.signUp).not.toHaveBeenCalled();
  });

  it("asks the user to check their email when confirmation is required", async () => {
    vi.mocked(authApi.signUp).mockResolvedValue({ ok: true, data: { session: null } });
    await renderApp("/auth/sign-up?next=%2Fportfolio");
    fill("Email", "New@Example.test");
    fill("Password", "Abcdefghi1");
    submit("Create account");
    await waitFor(() => expect(authApi.signUp).toHaveBeenCalledWith("new@example.test", "Abcdefghi1", "/portfolio"));
    expect(await screen.findByText(/check your email/i)).toBeTruthy();
    expect(screen.getByText(/new@example\.test/)).toBeTruthy();
  });

  it("signs the user in directly when the project auto-confirms", async () => {
    vi.mocked(authApi.signUp).mockResolvedValue({ ok: true, data: { session: makeSession(passwordUser) } });
    const { router, store } = await renderApp("/auth/sign-up");
    fill("Email", "new@example.test");
    fill("Password", "Abcdefghi1");
    submit("Create account");
    await waitFor(() => expect(authApi.signUp).toHaveBeenCalled());
    act(() => store.set(signedIn()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("shows a mapped error and sends a sanitised target", async () => {
    vi.mocked(authApi.signUp).mockResolvedValue({
      ok: false,
      code: "account_unavailable",
      message: "We could not create that account. If you already registered, sign in or reset your password.",
    });
    await renderApp("/auth/sign-up?next=https%3A%2F%2Fevil.com");
    fill("Email", "a@b.co");
    fill("Password", "Abcdefghi1");
    submit("Create account");
    expect(await screen.findByText(/could not create that account/i)).toBeTruthy();
    expect(authApi.signUp).toHaveBeenCalledWith("a@b.co", "Abcdefghi1", "/");
  });
});
```

`apps/web/src/features/auth/pages/callback-page.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { makeSession, passwordUser, signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

afterEach(() => {
  window.location.hash = "";
});

describe("callback page", () => {
  it("renders an error state with a retry link for an error parameter", async () => {
    await renderApp("/auth/callback?error=access_denied&error_description=User%20denied%20access");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cancelled/i);
    const retry = screen.getByRole("link", { name: "Try again" });
    expect(retry.getAttribute("href")).toBe("/auth/sign-in");
    expect(authApi.completeCallback).not.toHaveBeenCalled();
  });

  it("never renders the attacker-controlled error description", async () => {
    await renderApp("/auth/callback?error=access_denied&error_description=Your%20account%20is%20locked%2C%20call%20555-0100");
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toMatch(/555-0100/);
    expect(document.body.innerHTML).not.toMatch(/<img/i);
  });

  it("also reads an error from the URL fragment", async () => {
    window.location.hash = "#error=server_error";
    await renderApp("/auth/callback");
    expect((await screen.findByRole("alert")).textContent).toMatch(/problem/i);
    expect(authApi.completeCallback).not.toHaveBeenCalled();
  });

  it("completes the sign-in and follows a validated target", async () => {
    vi.mocked(authApi.completeCallback).mockResolvedValue({ ok: true, data: makeSession(passwordUser) });
    const { router } = await renderApp("/auth/callback?code=abc&next=%2Fportfolio", signedIn());
    await waitFor(() => expect(router.state.location.pathname).toBe("/portfolio"));
    expect(authApi.completeCallback).toHaveBeenCalledWith("abc");
  });

  it("ignores a hostile target after a successful exchange", async () => {
    vi.mocked(authApi.completeCallback).mockResolvedValue({ ok: true, data: makeSession(passwordUser) });
    const { router } = await renderApp("/auth/callback?code=abc&next=%2F%2Fevil.com", signedIn());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("shows the error state when the exchange fails", async () => {
    vi.mocked(authApi.completeCallback).mockResolvedValue({
      ok: false,
      code: "callback_failed",
      message: "Sign-in could not be completed. Start again.",
    });
    await renderApp("/auth/callback?code=expired");
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be completed/i);
    expect(screen.getByRole("link", { name: "Try again" })).toBeTruthy();
  });

  it("fails cleanly when there is neither a code nor an error", async () => {
    vi.mocked(authApi.completeCallback).mockResolvedValue({
      ok: false,
      code: "callback_failed",
      message: "Sign-in could not be completed. Start again.",
    });
    await renderApp("/auth/callback");
    await screen.findByRole("alert");
    expect(authApi.completeCallback).toHaveBeenCalledWith(undefined);
  });
});
```

`apps/web/src/features/auth/pages/reset-page.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { fill, renderApp, submit } from "@/test/render-app";

describe("reset page", () => {
  it("validates the email", async () => {
    await renderApp("/auth/reset");
    fill("Email", "nope");
    submit("Send reset link");
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(authApi.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("shows the same confirmation whether or not the account exists", async () => {
    vi.mocked(authApi.requestPasswordReset).mockResolvedValue({ ok: true, data: undefined });
    await renderApp("/auth/reset");
    fill("Email", "Someone@Example.test");
    submit("Send reset link");
    await waitFor(() => expect(authApi.requestPasswordReset).toHaveBeenCalledWith("someone@example.test"));
    expect(await screen.findByText(/if an account exists/i)).toBeTruthy();
    expect(screen.getByText(/same browser/i)).toBeTruthy();
  });

  it("surfaces a rate limit", async () => {
    vi.mocked(authApi.requestPasswordReset).mockResolvedValue({
      ok: false,
      code: "email_rate_limited",
      message: "Too many emails were requested. Wait before asking for another one.",
    });
    await renderApp("/auth/reset");
    fill("Email", "a@b.co");
    submit("Send reset link");
    expect(await screen.findByText(/too many emails/i)).toBeTruthy();
  });

  it("keeps /auth/forgot as an alias", async () => {
    const { router } = await renderApp("/auth/forgot");
    expect(router.state.location.pathname).toBe("/auth/reset");
  });
});
```

`apps/web/src/features/auth/pages/update-password-page.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { loading, passwordUser, signedIn, signedOut } from "@/test/auth-fixtures";
import { fill, renderApp, submit } from "@/test/render-app";

const recovery = signedIn(passwordUser, { recovery: true });

describe("update-password page", () => {
  it("shows the form while the recovery flag is set", async () => {
    await renderApp("/auth/update-password", recovery);
    expect(screen.getByRole("heading", { level: 1, name: "Set a new password" })).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
  });

  it("shows only a skeleton while auth state is loading", async () => {
    await renderApp("/auth/update-password", loading);
    expect(screen.getByTestId("auth-skeleton")).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("is not reachable without a session", async () => {
    const { router } = await renderApp("/auth/update-password", signedOut);
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/reset"));
  });

  it("sends a signed-in user without the recovery flag to Profile instead", async () => {
    const { router } = await renderApp("/auth/update-password", signedIn());
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile/security"));
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("validates the policy and the confirmation before calling the API", async () => {
    await renderApp("/auth/update-password", recovery);
    fill("New password", "short");
    fill("Confirm new password", "different");
    submit("Update password");
    expect(await screen.findByText(/at least 10 characters/i)).toBeTruthy();
    expect(authApi.updatePassword).not.toHaveBeenCalled();
    fill("New password", "Abcdefghi1");
    fill("Confirm new password", "Abcdefghi2");
    submit("Update password");
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy();
    expect(authApi.updatePassword).not.toHaveBeenCalled();
  });

  it("updates the password, clears the recovery flag and confirms", async () => {
    vi.mocked(authApi.updatePassword).mockResolvedValue({ ok: true, data: undefined });
    const { store } = await renderApp("/auth/update-password", recovery);
    fill("New password", "Abcdefghi1");
    fill("Confirm new password", "Abcdefghi1");
    submit("Update password");
    await waitFor(() => expect(authApi.updatePassword).toHaveBeenCalledWith("Abcdefghi1", "recovery"));
    expect(await screen.findByText("Your password has been updated.")).toBeTruthy();
    expect(store.getState().recovery).toBe(false);
    expect(screen.getByRole("link", { name: "Continue to the app" }).getAttribute("href")).toBe("/");
  });

  it("shows the mapped error and keeps the recovery flag when the update fails", async () => {
    vi.mocked(authApi.updatePassword).mockResolvedValue({
      ok: false,
      code: "same_password",
      message: "Choose a password that is different from the current one.",
    });
    const { store } = await renderApp("/auth/update-password", recovery);
    fill("New password", "Abcdefghi1");
    fill("Confirm new password", "Abcdefghi1");
    submit("Update password");
    expect(await screen.findByText(/different from the current one/i)).toBeTruthy();
    expect(store.getState().recovery).toBe(true);
  });
});
```

`apps/web/src/components/user-menu.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { loading, signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

function header() {
  return within(screen.getByRole("banner"));
}

describe("user menu", () => {
  it("shows the Profile link and Sign out when signed in", async () => {
    await renderApp("/", signedIn());
    expect(header().getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/profile");
    expect(header().getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(header().queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("shows Sign in when signed out", async () => {
    await renderApp("/");
    expect(header().getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/auth/sign-in");
    expect(header().queryByRole("link", { name: "Profile" })).toBeNull();
  });

  it("shows a placeholder, not Sign in or Profile, while loading", async () => {
    await renderApp("/", loading);
    expect(screen.getByTestId("user-menu-loading")).toBeTruthy();
    expect(header().queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(header().queryByRole("link", { name: "Profile" })).toBeNull();
  });

  it("navigates to the signed-out page and signs out locally", async () => {
    vi.mocked(authApi.signOut).mockResolvedValue({ ok: true, data: undefined });
    const { router } = await renderApp("/portfolio", signedIn());
    fireEvent.click(header().getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/signed-out"));
    expect(authApi.signOut).toHaveBeenCalledWith("local");
    expect(await screen.findByRole("heading", { level: 1, name: "You are signed out" })).toBeTruthy();
  });
});
```

`apps/web/src/auth-routes-cache.test.ts` (pins failure mode 2 for every auth route):

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNavigationFallbackAllowed, isNeverCached } from "./sw-routes";

const ORIGIN = "https://app.example.com";
const AUTH_PATHS = [
  "/auth/sign-in",
  "/auth/sign-up",
  "/auth/callback",
  "/auth/reset",
  "/auth/forgot",
  "/auth/update-password",
  "/auth/signed-out",
];

describe("auth routes and the service worker", () => {
  it.each(AUTH_PATHS)("%s is excluded from the navigation fallback", (path) => {
    expect(isNavigationFallbackAllowed(new URL(`${ORIGIN}${path}?code=abc&next=%2Fportfolio`))).toBe(false);
  });

  it.each(AUTH_PATHS)("%s is never cached", (path) => {
    expect(isNeverCached(new URL(`${ORIGIN}${path}?code=abc`), new Headers(), ORIGIN)).toBe(true);
  });

  it("still allows the fallback for application routes", () => {
    for (const path of ["/", "/quotes", "/portfolio", "/profile/security", "/author"]) {
      expect(isNavigationFallbackAllowed(new URL(`${ORIGIN}${path}`))).toBe(true);
    }
  });
});

describe("public/_headers", () => {
  const text = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

  function rule(path: string): Map<string, string> {
    const out = new Map<string, string>();
    let active = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (!/^\s/.test(line)) {
        active = line.trim() === path;
        continue;
      }
      const colon = line.indexOf(":");
      if (active && colon > 0) out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    return out;
  }

  it("never lets the CDN or the browser cache the OAuth callback and the other auth pages", () => {
    expect(rule("/auth/*").get("cache-control")).toBe("no-store");
  });
});
```

Run: `bun run test:web -- sign-in-page sign-up-page callback-page reset-page update-password-page user-menu auth-routes-cache`
Expected: FAIL (missing modules and routes).

- [ ] **Step 3: Replace the P0 shell test**

`apps/web/src/components/app-shell.test.tsx` (full replacement; the P0 rows stay, protected rows now render signed in, `/auth/sign-in` renders the real page):

```tsx
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

const PUBLIC_ROUTES: Array<[string, string]> = [
  ["/", "Overview"],
  ["/quotes", "Quotes"],
  ["/about", "About"],
  ["/auth/sign-in", "Sign in"],
  ["/auth/sign-up", "Create account"],
  ["/auth/reset", "Reset password"],
  ["/auth/signed-out", "You are signed out"],
  ["/no-such-page", "Page not found"],
];

const PROTECTED_ROUTES: Array<[string, string]> = [
  ["/portfolio", "Portfolio"],
  ["/analytics", "Analytics"],
  ["/profile", "Security"],
  ["/profile/security", "Security"],
  ["/profile/broker", "Broker"],
  ["/profile/notifications", "Notifications"],
];

describe("app shell", () => {
  it.each(PUBLIC_ROUTES)("public route %s renders the heading %s when signed out", async (path, heading) => {
    await renderApp(path, signedOut);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it.each(PROTECTED_ROUTES)("protected route %s renders the heading %s when signed in", async (path, heading) => {
    await renderApp(path, signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("renders primary and mobile navigation with the current page marked", async () => {
    await renderApp("/quotes", signedOut);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const mobile = screen.getByRole("navigation", { name: "Mobile" });
    for (const nav of [primary, mobile]) {
      const labels = within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim());
      expect(labels).toEqual(["Overview", "Quotes", "Portfolio", "Analytics"]);
      expect(within(nav).getByRole("link", { name: "Quotes" }).getAttribute("aria-current")).toBe("page");
    }
  });

  it("exposes landmarks, a skip link, the profile link and the theme toggle when signed in", async () => {
    await renderApp("/", signedIn());
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Theme/ })).toBeTruthy();
  });
});
```

(`/profile/broker` and `/profile/notifications` render the P0 placeholders until Task 5 replaces them; the headings stay `Broker` and `Notifications`.)

- [ ] **Step 4: Implement the guard, the card and the hooks**

`apps/web/src/features/auth/guards.ts`:

```ts
import { redirect } from "@tanstack/react-router";
import type { AuthStore } from "./auth-store";
import { nextSearch, safeNext } from "./redirects";

export interface GuardArgs {
  context: { auth: AuthStore };
  location: { href: string };
}

/**
 * beforeLoad guard for protected routes. While auth state is "loading" it lets the route load; the
 * route component is wrapped in <AuthGate>, which shows a skeleton and never the protected content,
 * and AuthRouteSync re-runs this guard (router.invalidate) when the state resolves.
 */
export function requireAuth({ context, location }: GuardArgs): void {
  const state = context.auth.getState();
  if (state.status === "signed-out") {
    throw redirect({ to: "/auth/sign-in", search: nextSearch(safeNext(location.href)) });
  }
  if (state.status === "signed-in" && state.recovery) {
    // A password-recovery session may do one thing: set a new password.
    throw redirect({ to: "/auth/update-password" });
  }
}
```

`apps/web/src/features/auth/callback-params.ts`:

```ts
import { z } from "zod";

const text = z.string().max(2048).optional().catch(undefined);
const callbackSchema = z.object({ code: text, next: text, error: text });

export interface CallbackSearch {
  code?: string;
  next?: string;
  error?: string;
}

/** Keeps only the known string parameters of /auth/callback; everything else is dropped. */
export function parseCallbackSearch(search: Record<string, unknown>): CallbackSearch {
  const parsed = callbackSchema.parse(search);
  const out: CallbackSearch = {};
  if (parsed.code !== undefined) out.code = parsed.code;
  if (parsed.next !== undefined) out.next = parsed.next;
  if (parsed.error !== undefined) out.error = parsed.error;
  return out;
}

/** Providers may report errors in the URL fragment instead of the query string. */
export function readHashError(hash: string): string | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("error");
  return value === null || value === "" ? undefined : value.slice(0, 64);
}

const GENERIC = "Sign-in could not be completed. Start again.";

/**
 * Fixed messages only. error and error_description come from the URL, so anyone can craft a link
 * that shows arbitrary text under this domain; the raw values are never rendered.
 */
export function describeCallbackError(error: string): string {
  switch (error) {
    case "access_denied":
      return "Sign-in was cancelled or not allowed. You can try again.";
    case "server_error":
    case "temporarily_unavailable":
      return "The sign-in service had a problem. Try again in a moment.";
    default:
      return GENERIC;
  }
}
```

`apps/web/src/features/auth/use-next-param.ts`:

```ts
import { useSearch } from "@tanstack/react-router";

/** The raw `next` search parameter, if it is a string. Always pass it through safeNext before use. */
export function useNextParam(): string | undefined {
  const search = useSearch({ strict: false }) as { next?: unknown };
  return typeof search.next === "string" ? search.next : undefined;
}
```

`apps/web/src/features/auth/use-redirect-when-signed-in.ts`:

```ts
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "./auth-provider";
import { safeNext } from "./redirects";

/** Sends a signed-in visitor of an auth page to the validated `next` target. */
export function useRedirectWhenSignedIn(next: string | undefined): void {
  const { status, recovery } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "signed-in" && !recovery) router.history.replace(safeNext(next));
  }, [status, recovery, next, router]);
}
```

`apps/web/src/features/auth/components/auth-card.tsx`:

```tsx
import { type ReactNode, useEffect } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";

interface AuthCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  useEffect(() => {
    document.title = `${title} - Stock Screener`;
  }, [title]);
  return (
    <section aria-labelledby="auth-title" className="mx-auto w-full max-w-md py-6">
      <Card>
        <CardHeader>
          <h1 id="auth-title" className="text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
        {footer ? <CardFooter className="flex flex-col items-start gap-2 text-sm">{footer}</CardFooter> : null}
      </Card>
    </section>
  );
}
```

- [ ] **Step 5: Implement the auth pages**

`apps/web/src/features/auth/pages/sign-in-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AuthFailure } from "../api";
import { AuthCard } from "../components/auth-card";
import { TextField } from "../components/text-field";
import { authApi } from "../default";
import { nextSearch, safeNext } from "../redirects";
import { fieldErrors, signInSchema } from "../schemas";
import { useNextParam } from "../use-next-param";
import { useRedirectWhenSignedIn } from "../use-redirect-when-signed-in";

export function SignInPage() {
  const next = useNextParam();
  useRedirectWhenSignedIn(next);
  const target = safeNext(next);
  const search = nextSearch(target);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setResent(false);
    const parsed = signInSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.signInWithPassword(parsed.data.email, parsed.data.password);
    setPending(false);
    // On success the auth store emits SIGNED_IN and useRedirectWhenSignedIn navigates.
    if (!result.ok) setFailure(result);
  }

  async function onGoogle() {
    setFailure(null);
    const result = await authApi.signInWithGoogle(target);
    if (!result.ok) setFailure(result);
  }

  async function onResend() {
    const result = await authApi.resendConfirmation(email.trim().toLowerCase(), target);
    if (result.ok) setResent(true);
    else setFailure(result);
  }

  return (
    <AuthCard
      title="Sign in"
      description="Sign in to see your portfolio, analytics and profile."
      footer={
        <>
          <Link to="/auth/sign-up" search={search} className="underline underline-offset-4">
            Create an account
          </Link>
          <Link to="/auth/reset" className="underline underline-offset-4">
            Forgot your password?
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
        />
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
          </p>
        ) : null}
        {failure?.code === "email_not_confirmed" ? (
          <Button type="button" variant="outline" onClick={onResend}>
            Resend confirmation email
          </Button>
        ) : null}
        {resent ? (
          <p role="status" className="text-sm">
            A new confirmation email is on its way.
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending}>
          Sign in
        </Button>
      </form>
      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button type="button" variant="outline" className="w-full" onClick={onGoogle}>
        Continue with Google
      </Button>
    </AuthCard>
  );
}
```

`apps/web/src/features/auth/pages/sign-up-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AuthFailure } from "../api";
import { AuthCard } from "../components/auth-card";
import { TextField } from "../components/text-field";
import { authApi } from "../default";
import { nextSearch, safeNext } from "../redirects";
import { fieldErrors, PASSWORD_POLICY_TEXT, signUpSchema } from "../schemas";
import { useNextParam } from "../use-next-param";
import { useRedirectWhenSignedIn } from "../use-redirect-when-signed-in";

export function SignUpPage() {
  const next = useNextParam();
  useRedirectWhenSignedIn(next);
  const target = safeNext(next);
  const search = nextSearch(target);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = signUpSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.signUp(parsed.data.email, parsed.data.password, target);
    setPending(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    // With confirmations off (local) the project returns a session and the redirect hook takes over.
    if (result.data.session === null) setSentTo(parsed.data.email);
  }

  async function onResend() {
    if (sentTo === null) return;
    const result = await authApi.resendConfirmation(sentTo, target);
    if (result.ok) setResent(true);
    else setFailure(result);
  }

  async function onGoogle() {
    const result = await authApi.signInWithGoogle(target);
    if (!result.ok) setFailure(result);
  }

  if (sentTo !== null) {
    return (
      <AuthCard
        title="Check your email"
        footer={
          <Link to="/auth/sign-in" search={search} className="underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p role="status">
          We sent a confirmation link to <strong>{sentTo}</strong>. Open it in this browser to finish creating
          your account.
        </p>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
          </p>
        ) : null}
        {resent ? <p className="text-sm">A new confirmation email is on its way.</p> : null}
        <Button type="button" variant="outline" onClick={onResend}>
          Resend confirmation email
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create account"
      description="Use an email address you can open, or continue with Google."
      footer={
        <Link to="/auth/sign-in" search={search} className="underline underline-offset-4">
          I already have an account
        </Link>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint={PASSWORD_POLICY_TEXT}
          error={errors.password}
        />
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending}>
          Create account
        </Button>
      </form>
      <Button type="button" variant="outline" className="w-full" onClick={onGoogle}>
        Continue with Google
      </Button>
    </AuthCard>
  );
}
```

`apps/web/src/features/auth/pages/callback-page.tsx`:

```tsx
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AuthCard } from "../components/auth-card";
import { describeCallbackError, parseCallbackSearch, readHashError } from "../callback-params";
import { authApi } from "../default";
import { nextSearch, safeNext } from "../redirects";

export function CallbackPage() {
  const router = useRouter();
  const { code, next, error } = parseCallbackSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const errorParam = error ?? readHashError(window.location.hash);
  const [failure, setFailure] = useState<string | null>(errorParam ? describeCallbackError(errorParam) : null);

  useEffect(() => {
    if (errorParam) return;
    let cancelled = false;
    void authApi.completeCallback(code).then((result) => {
      if (cancelled) return;
      if (result.ok) router.history.replace(safeNext(next));
      else setFailure(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [code, next, errorParam, router]);

  if (failure !== null) {
    return (
      <AuthCard title="Sign-in failed">
        <p role="alert" className="text-sm">
          {failure}
        </p>
        <Button asChild>
          <Link to="/auth/sign-in" search={nextSearch(safeNext(next))}>
            Try again
          </Link>
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Signing you in">
      <p role="status">Completing sign-in...</p>
    </AuthCard>
  );
}
```

`apps/web/src/features/auth/pages/reset-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { AuthCard } from "../components/auth-card";
import { TextField } from "../components/text-field";
import { authApi } from "../default";
import { fieldErrors, resetRequestSchema } from "../schemas";

export function ResetPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = resetRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).email);
      return;
    }
    setError(undefined);
    setPending(true);
    const result = await authApi.requestPasswordReset(parsed.data.email);
    setPending(false);
    if (result.ok) setSent(true);
    else setFailure(result.message);
  }

  return (
    <AuthCard
      title="Reset password"
      description="Enter your email and we will send you a link to choose a new password."
      footer={
        <Link to="/auth/sign-in" className="underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p role="status">
          If an account exists for that address, a reset link is on its way. Open the link in the same browser you
          are using now.
        </p>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <TextField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            error={error}
          />
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
```

`apps/web/src/features/auth/pages/update-password-page.tsx`:

```tsx
import { Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "../auth-provider";
import { AuthCard } from "../components/auth-card";
import { AuthSkeleton } from "../components/auth-skeleton";
import { TextField } from "../components/text-field";
import { authApi } from "../default";
import { fieldErrors, newPasswordSchema, PASSWORD_POLICY_TEXT } from "../schemas";

/**
 * Reached through the password-reset email. The recovery link signs the user in, so the page is
 * only usable while the in-memory recovery flag is set; anyone else is sent away.
 */
export function UpdatePasswordPage() {
  const { status, recovery } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;
    if (status === "signed-out") router.history.replace("/auth/reset");
    else if (status === "signed-in" && !recovery) router.history.replace("/profile/security");
  }, [status, recovery, done, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = newPasswordSchema.safeParse({ password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.updatePassword(parsed.data.password, "recovery");
    setPending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setDone(true); // first: the redirect effect must see `done` before the recovery flag is cleared
    router.options.context.auth.clearRecovery();
  }

  if (done) {
    return (
      <AuthCard title="Password updated">
        <p role="status">Your password has been updated.</p>
        <Button asChild>
          <Link to="/">Continue to the app</Link>
        </Button>
      </AuthCard>
    );
  }
  if (status === "loading" || !recovery) return <AuthSkeleton />;

  return (
    <AuthCard title="Set a new password" description="Choose a new password for your account.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint={PASSWORD_POLICY_TEXT}
          error={errors.password}
        />
        <TextField
          id="confirm-password"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
        />
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending}>
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}
```

`apps/web/src/features/auth/pages/signed-out-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { AuthCard } from "../components/auth-card";

export function SignedOutPage() {
  return (
    <AuthCard title="You are signed out">
      <p>You have been signed out of this device.</p>
      <div className="flex gap-2">
        <Button asChild>
          <Link to="/auth/sign-in">Sign in again</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/">Back to Overview</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
```

`apps/web/src/components/auth-route-sync.tsx`:

```tsx
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/features/auth/auth-provider";

/** Re-runs the route guards whenever the auth state changes (loading -> signed-out, sign-out, recovery). */
export function AuthRouteSync() {
  const { status, recovery } = useAuth();
  const router = useRouter();
  // biome-ignore lint/correctness/useExhaustiveDependencies: status and recovery are the triggers
  useEffect(() => {
    void router.invalidate();
  }, [status, recovery, router]);
  return null;
}
```

`apps/web/src/components/user-menu.tsx`:

```tsx
import { Link, useRouter } from "@tanstack/react-router";
import { LogIn, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { authApi } from "@/features/auth/default";

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring";
const linkClass = `inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:text-accent-foreground ${focusRing}`;

export function UserMenu() {
  const { status } = useAuth();
  const router = useRouter();

  if (status === "loading") {
    return <span aria-hidden="true" data-testid="user-menu-loading" className="h-9 w-24 animate-pulse rounded-md bg-muted" />;
  }
  if (status === "signed-out") {
    return (
      <Link to="/auth/sign-in" className={linkClass}>
        <LogIn className="size-4" aria-hidden="true" />
        Sign in
      </Link>
    );
  }

  async function onSignOut() {
    // Navigate first: the signed-out state would otherwise bounce a protected page to the sign-in form.
    await router.navigate({ to: "/auth/signed-out" });
    await authApi.signOut("local");
  }

  return (
    <>
      <Link to="/profile" className={linkClass}>
        <User className="size-4" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Profile</span>
      </Link>
      <Button type="button" variant="ghost" size="sm" onClick={onSignOut}>
        Sign out
      </Button>
    </>
  );
}
```

- [ ] **Step 6: Wire the router, providers, shell and headers**

Replace `apps/web/src/router.tsx`:

```tsx
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import type { AuthStore } from "@/features/auth/auth-store";
import { parseCallbackSearch } from "@/features/auth/callback-params";
import { AuthGate } from "@/features/auth/components/auth-gate";
import { authStore } from "@/features/auth/default";
import { requireAuth } from "@/features/auth/guards";
import { CallbackPage } from "@/features/auth/pages/callback-page";
import { ResetPage } from "@/features/auth/pages/reset-page";
import { SignInPage } from "@/features/auth/pages/sign-in-page";
import { SignUpPage } from "@/features/auth/pages/sign-up-page";
import { SignedOutPage } from "@/features/auth/pages/signed-out-page";
import { UpdatePasswordPage } from "@/features/auth/pages/update-password-page";
import {
  AboutPage,
  AnalyticsPage,
  NotFoundPage,
  OverviewPage,
  PortfolioPage,
  ProfileBrokerPage,
  ProfileNotificationsPage,
  ProfileSecurityPage,
  QuotesPage,
} from "@/features/pages";

export interface RouterContext {
  auth: AuthStore;
}

const nextSchema = z.object({ next: z.string().max(512).optional().catch(undefined) });

/** Search validation: keeps `next` only when it is a string. Pages still pass it through safeNext. */
function parseNext(search: Record<string, unknown>): { next?: string } {
  const { next } = nextSchema.parse(search);
  return next === undefined ? {} : { next };
}

function guarded(Page: ComponentType) {
  return function GuardedPage() {
    return (
      <AuthGate>
        <Page />
      </AuthGate>
    );
  };
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const quotesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/quotes", component: QuotesPage });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: "/about", component: AboutPage });

const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/portfolio",
  beforeLoad: requireAuth,
  component: guarded(PortfolioPage),
});
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  beforeLoad: requireAuth,
  component: guarded(AnalyticsPage),
});

// Profile: the layout route carries the guard, so every child is protected (spec 11.5).
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  beforeLoad: requireAuth,
  component: guarded(Outlet),
});
const profileIndexRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/profile/security" });
  },
});
const profileSecurityRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "security",
  component: ProfileSecurityPage,
});
const profileBrokerRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "broker",
  component: ProfileBrokerPage,
});
const profileNotificationsRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "notifications",
  component: ProfileNotificationsPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/sign-in",
  validateSearch: parseNext,
  component: SignInPage,
});
const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/sign-up",
  validateSearch: parseNext,
  component: SignUpPage,
});
const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  validateSearch: parseCallbackSearch,
  component: CallbackPage,
});
const resetRoute = createRoute({ getParentRoute: () => rootRoute, path: "/auth/reset", component: ResetPage });
const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/forgot",
  beforeLoad: () => {
    throw redirect({ to: "/auth/reset" });
  },
});
const updatePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/update-password",
  component: UpdatePasswordPage,
});
const signedOutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/signed-out",
  component: SignedOutPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  quotesRoute,
  aboutRoute,
  portfolioRoute,
  analyticsRoute,
  profileRoute.addChildren([profileIndexRoute, profileSecurityRoute, profileBrokerRoute, profileNotificationsRoute]),
  signInRoute,
  signUpRoute,
  callbackRoute,
  resetRoute,
  forgotRoute,
  updatePasswordRoute,
  signedOutRoute,
]);

export function createAppRouter(history?: RouterHistory, auth: AuthStore = authStore) {
  return createRouter({
    routeTree,
    context: { auth },
    defaultPreload: "intent",
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

In `apps/web/src/providers.tsx` add the store to the props and wrap the children (keep the existing imports; add the three marked ones):

```tsx
import { AuthProvider } from "@/features/auth/auth-provider";
import type { AuthStore } from "@/features/auth/auth-store";
import { authStore as defaultAuthStore } from "@/features/auth/default";

interface AppProvidersProps {
  children: ReactNode;
  queryClient?: QueryClient;
  authStore?: AuthStore;
}

export function AppProviders({
  children,
  queryClient = defaultQueryClient,
  authStore = defaultAuthStore,
}: AppProvidersProps) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider store={authStore}>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

`apps/web/src/components/app-shell.tsx` (three edits; if skills refined the P0 markup, apply the same change at the equivalent place):
1. Remove `User` from the `lucide-react` import and add `import { AuthRouteSync } from "@/components/auth-route-sync";` and `import { UserMenu } from "@/components/user-menu";`.
2. Replace this block

```tsx
            <Link to="/profile" className={topLink}>
              <User className="size-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Profile</span>
            </Link>
```

with `<UserMenu />`.
3. Make `<AuthRouteSync />` the first child of the root `<div className="flex min-h-dvh flex-col bg-background text-foreground">`.

`apps/web/src/features/pages.tsx`: delete the `AuthPage` function (the whole `export function AuthPage() { ... }` block) and nothing else.

`apps/web/public/_headers`: add this rule after the `/index.html` rule:

```text
/auth/*
  Cache-Control: no-store
```

- [ ] **Step 7: Run the tests, lint and typecheck**

Run: `bun run test:web`
Expected: all web tests pass (P0, Task 3 and the new ones, about 120).

If a test fails because TanStack Router does not render a pending state or re-runs `beforeLoad` differently from the assumption in `AuthRouteSync` (guard tests `redirects when loading resolves to signed-out` and `sends a signed-out transition ...`), do not delete the test: debug with `router.state.status`, and if `invalidate()` does not re-run `beforeLoad` in the installed version use `router.navigate({ to: router.state.location.href, replace: true })` inside `AuthRouteSync` instead. Record the outcome in the results file.

Run: `bun run lint:fix` then `bun run lint`, `bun run typecheck`, `bun run build`, `bun run check:bundle`
Expected: exit 0 each; `check:bundle` prints `bundle secret scan: OK (N files)`. `bun run build` needs no Supabase variables (the Vite build does not evaluate `import.meta.env` values), but the preview needs them; the e2e task sets them.

- [ ] **Step 8: Commit**

```text
git add apps/web/src apps/web/public/_headers
git commit -m "feat(web): add auth routes, protected-route guard, user menu and no-store rule for auth pages"
```

---

### Task 5: Profile pages (layout, Security, Broker and Notifications shells)

**Concurrency:** Steps 1 to 6 touch only new files under `apps/web/src/features/profile/` and `apps/web/src/test/profile-default-mock.ts`, so they may run at the same time as Task 4 (after Task 3 is merged). **Step 7 edits `router.tsx`, `pages.tsx` and `setup.ts` and must wait until Task 4 is merged.** The component tests render through the real router, so they can only be run in Step 7.

**REQUIRED before Step 4 (components):** the implementer MUST load the `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills (Skill tool). The code below is a complete, working baseline; the skills may refine spacing, card layout and copy styling. Fixed constraints: keep every heading, label, button name, badge text and sentence used by the tests; shadcn components and P0 tokens only; the Google-only sentence is verbatim; status is never colour only; usable at phone width.

**Files:**
- Create: `apps/web/src/features/profile/profile-api.ts`, `default.ts`, `profile-layout.tsx`, `broker-page.tsx`, `notifications-page.tsx`
- Create: `apps/web/src/features/profile/panels/broker-panel.tsx`, `panels/notifications-panel.tsx`
- Create: `apps/web/src/features/profile/security/security-page.tsx`, `display-name-card.tsx`, `password-card.tsx`, `google-only-card.tsx`, `sessions-card.tsx`
- Create tests: `apps/web/src/features/profile/profile-api.test.ts`, `profile-layout.test.tsx`, `profile-panels.test.tsx`, `security/security-page.test.tsx`, `apps/web/src/test/profile-default-mock.ts`
- Modify (Step 7 only): `apps/web/src/router.tsx`, `apps/web/src/features/pages.tsx`, `apps/web/src/test/setup.ts`

**Interfaces:**
- Consumes: Task 3 (`useAuth`, `authApi`, `hasPasswordIdentity`, `isGoogleOnly`, `providersOf`, schemas, fixtures, `AuthGate`, `TextField`); Task 4 only in Step 7 (`renderApp`, the guarded `/profile` routes in `router.tsx`); P0 shadcn components (`card`, `badge`, `button`, `input`, `label`, `skeleton`, `sonner`).
- Produces: `createProfileApi(client)` with `getProfile(userId)` and `updateDisplayName(userId, name)`; `displayNameSchema`; `profileApi` singleton; `ProfileLayout`; `SecurityPage`; `ProfileBrokerPage` and `ProfileNotificationsPage` (heading plus a replaceable panel); `BrokerPanel` and `NotificationsPanel` (P5b and P3 replace only these two files); the global mock `profileApiMock`.

- [ ] **Step 1: Write the tests**

`apps/web/src/features/profile/profile-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createProfileApi, displayNameSchema } from "./profile-api";

function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eqSelect = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: eqSelect });
  const eqUpdate = vi.fn().mockResolvedValue({ error: result.error });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });
  const from = vi.fn().mockReturnValue({ select, update });
  return { from, select, eqSelect, update, eqUpdate, client: { from } as unknown as Parameters<typeof createProfileApi>[0] };
}

describe("getProfile", () => {
  it("selects only the two columns for the user", async () => {
    const m = makeClient({ data: { user_id: "u1", display_name: "Alice" }, error: null });
    expect(await createProfileApi(m.client).getProfile("u1")).toEqual({ userId: "u1", displayName: "Alice" });
    expect(m.from).toHaveBeenCalledWith("profiles");
    expect(m.select).toHaveBeenCalledWith("user_id, display_name");
    expect(m.eqSelect).toHaveBeenCalledWith("user_id", "u1");
  });

  it("returns null when there is no row and throws a fixed message on error", async () => {
    expect(await createProfileApi(makeClient({ data: null, error: null }).client).getProfile("u1")).toBeNull();
    await expect(
      createProfileApi(makeClient({ data: null, error: { message: "secret db detail" } }).client).getProfile("u1"),
    ).rejects.toThrow("Could not load your profile.");
  });
});

describe("updateDisplayName", () => {
  it("writes the trimmed name for the user only", async () => {
    const m = makeClient({ data: null, error: null });
    await createProfileApi(m.client).updateDisplayName("u1", "  Alice B  ");
    expect(m.update).toHaveBeenCalledWith({ display_name: "Alice B" });
    expect(m.eqUpdate).toHaveBeenCalledWith("user_id", "u1");
  });

  it("rejects an invalid name before any request and maps a database error", async () => {
    const m = makeClient({ data: null, error: { message: "secret db detail" } });
    const api = createProfileApi(m.client);
    await expect(api.updateDisplayName("u1", "   ")).rejects.toThrow();
    expect(m.update).not.toHaveBeenCalled();
    await expect(api.updateDisplayName("u1", "Alice")).rejects.toThrow("Could not save your name.");
  });
});

describe("displayNameSchema", () => {
  it.each([["Alice"], ["A"], ["x".repeat(60)]])("accepts %s", (value) => {
    expect(displayNameSchema.safeParse(value).success).toBe(true);
  });
  it.each([[""], ["   "], ["x".repeat(61)], ["bad\u0000name"], ["tab\tname"]])("rejects %j", (value) => {
    expect(displayNameSchema.safeParse(value).success).toBe(false);
  });
});
```

`apps/web/src/features/profile/security/security-page.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { profileApi } from "@/features/profile/default";
import { bothUser, googleUser, makeIdentity, makeUser, passwordUser, signedIn } from "@/test/auth-fixtures";
import { fill, renderApp, submit } from "@/test/render-app";

const GOOGLE_EXPLANATION =
  "Your account signs in with Google; there is no password to change. Manage security in your Google account.";

beforeEach(() => {
  vi.mocked(profileApi.getProfile).mockResolvedValue({ userId: "user-1", displayName: "Alice" });
});

describe("Security: email", () => {
  it("shows the email read-only with a Verified badge", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    expect(screen.getByText("alice@example.test")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByDisplayValue("alice@example.test")).toBeNull();
  });

  it("does not claim verification when the email is unconfirmed", async () => {
    const unconfirmed = makeUser({ ...passwordUser, email_confirmed_at: "" });
    await renderApp("/profile/security", signedIn(unconfirmed));
    expect(await screen.findByText("Not verified")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
  });
});

describe("Security: password branch", () => {
  it("shows the password form for an account with an email identity", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByLabelText("Current password")).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
    expect(screen.queryByText(GOOGLE_EXPLANATION)).toBeNull();
  });

  it("shows the form for an account that has both providers", async () => {
    await renderApp("/profile/security", signedIn(bothUser));
    expect(await screen.findByLabelText("New password")).toBeTruthy();
    expect(screen.queryByText(GOOGLE_EXPLANATION)).toBeNull();
  });

  it("validates before calling the API", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    submit("Change password");
    expect(await screen.findByText("Enter your current password.")).toBeTruthy();
    fill("Current password", "Old-Passw0rd-1");
    fill("New password", "New-Passw0rd-2");
    fill("Confirm new password", "New-Passw0rd-3");
    submit("Change password");
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy();
    expect(authApi.changePassword).not.toHaveBeenCalled();
  });

  it("changes the password, confirms and clears the fields", async () => {
    vi.mocked(authApi.changePassword).mockResolvedValue({ ok: true, data: undefined });
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    fill("Current password", "Old-Passw0rd-1");
    fill("New password", "New-Passw0rd-2");
    fill("Confirm new password", "New-Passw0rd-2");
    submit("Change password");
    await waitFor(() =>
      expect(authApi.changePassword).toHaveBeenCalledWith("alice@example.test", "Old-Passw0rd-1", "New-Passw0rd-2"),
    );
    expect(await screen.findByText("Password updated.")).toBeTruthy();
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });

  it("shows the error when the current password is wrong", async () => {
    vi.mocked(authApi.changePassword).mockResolvedValue({
      ok: false,
      code: "invalid_credentials",
      message: "The current password is incorrect.",
    });
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    fill("Current password", "wrong");
    fill("New password", "New-Passw0rd-2");
    fill("Confirm new password", "New-Passw0rd-2");
    submit("Change password");
    expect(await screen.findByText("The current password is incorrect.")).toBeTruthy();
    expect(screen.queryByText("Password updated.")).toBeNull();
  });
});

describe("Security: Google-only branch", () => {
  it("explains instead of showing any password form", async () => {
    await renderApp("/profile/security", signedIn(googleUser));
    expect(await screen.findByText(GOOGLE_EXPLANATION)).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByLabelText("Confirm new password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
    const link = screen.getByRole("link", { name: /google account security/i });
    expect(link.getAttribute("href")).toBe("https://myaccount.google.com/security");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("is not fooled by stale app_metadata that still lists email", async () => {
    const stale = makeUser({
      identities: [makeIdentity("google")],
      app_metadata: { provider: "google", providers: ["google", "email"] },
    });
    await renderApp("/profile/security", signedIn(stale));
    expect(await screen.findByText(GOOGLE_EXPLANATION)).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("shows neither form nor Google text when the providers are unknown", async () => {
    const unknown = makeUser({ identities: [], app_metadata: {} });
    await renderApp("/profile/security", signedIn(unknown));
    expect(await screen.findByText("Password changes are not available for this account.")).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByText(GOOGLE_EXPLANATION)).toBeNull();
  });
});

describe("Security: providers and sessions", () => {
  it("lists the linked providers", async () => {
    await renderApp("/profile/security", signedIn(bothUser));
    const list = await screen.findByRole("list", { name: "Linked sign-in methods" });
    expect(within(list).getByText("Email and password")).toBeTruthy();
    expect(within(list).getByText("Google")).toBeTruthy();
  });

  it.each([
    ["password", passwordUser],
    ["Google-only", googleUser],
  ])("offers sign out of all devices to a %s account, with a confirmation step", async (_name, user) => {
    vi.mocked(authApi.signOut).mockResolvedValue({ ok: true, data: undefined });
    const { router } = await renderApp("/profile/security", signedIn(user));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of all devices" }));
    expect(authApi.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, sign out everywhere" }));
    await waitFor(() => expect(authApi.signOut).toHaveBeenCalledWith("global"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/signed-out"));
  });

  it("lets the user back out of the confirmation", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of all devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Yes, sign out everywhere" })).toBeNull();
    expect(authApi.signOut).not.toHaveBeenCalled();
  });
});

describe("Security: display name", () => {
  it("loads, edits and saves the display name", async () => {
    vi.mocked(profileApi.updateDisplayName).mockResolvedValue(undefined);
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByDisplayValue("Alice")).toBeTruthy();
    fill("Display name", "Alice B");
    submit("Save name");
    await waitFor(() => expect(profileApi.updateDisplayName).toHaveBeenCalledWith("user-1", "Alice B"));
    expect(await screen.findByText("Name saved.")).toBeTruthy();
  });

  it("validates the name before saving", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByDisplayValue("Alice");
    fill("Display name", "   ");
    submit("Save name");
    expect(await screen.findByText("Enter a name.")).toBeTruthy();
    expect(profileApi.updateDisplayName).not.toHaveBeenCalled();
  });

  it("shows an error with a retry when the profile cannot be loaded", async () => {
    vi.mocked(profileApi.getProfile).mockRejectedValueOnce(new Error("Could not load your profile."));
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByText("Could not load your profile.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("Alice")).toBeTruthy();
  });

  it("shows an error when saving fails", async () => {
    vi.mocked(profileApi.updateDisplayName).mockRejectedValue(new Error("Could not save your name."));
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByDisplayValue("Alice");
    fill("Display name", "Alice C");
    submit("Save name");
    expect(await screen.findByText("Could not save your name.")).toBeTruthy();
  });
});
```

`apps/web/src/features/profile/profile-layout.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileApi } from "@/features/profile/default";
import { signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

beforeEach(() => {
  vi.mocked(profileApi.getProfile).mockResolvedValue({ userId: "user-1", displayName: null });
});

describe("profile layout", () => {
  it("redirects /profile to /profile/security", async () => {
    const { router } = await renderApp("/profile", signedIn());
    expect(router.state.location.pathname).toBe("/profile/security");
  });

  it("renders a sub-navigation with Security, Broker and Notifications", async () => {
    await renderApp("/profile/security", signedIn());
    const nav = await screen.findByRole("navigation", { name: "Profile sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent?.trim())).toEqual(["Security", "Broker", "Notifications"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/profile/security",
      "/profile/broker",
      "/profile/notifications",
    ]);
  });

  it("marks only the current section as active", async () => {
    await renderApp("/profile/broker", signedIn());
    const nav = await screen.findByRole("navigation", { name: "Profile sections" });
    expect(within(nav).getByRole("link", { name: "Broker" }).getAttribute("data-status")).toBe("active");
    expect(within(nav).getByRole("link", { name: "Security" }).getAttribute("data-status")).not.toBe("active");
  });

  it("navigates between sections", async () => {
    const { router } = await renderApp("/profile/security", signedIn());
    const nav = await screen.findByRole("navigation", { name: "Profile sections" });
    fireEvent.click(within(nav).getByRole("link", { name: "Notifications" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile/notifications"));
    expect(await screen.findByRole("heading", { level: 1, name: "Notifications" })).toBeTruthy();
  });

  it("protects every child route", async () => {
    for (const section of ["security", "broker", "notifications"]) {
      const { router } = await renderApp(`/profile/${section}`, signedOut);
      expect(router.state.location.pathname).toBe("/auth/sign-in");
      expect(router.state.location.search).toEqual({ next: `/profile/${section}` });
    }
  });
});
```

`apps/web/src/features/profile/profile-panels.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

describe("Broker and Notifications shells", () => {
  it("renders the Broker heading and the replaceable placeholder card", async () => {
    await renderApp("/profile/broker", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Broker" })).toBeTruthy();
    expect(screen.getByText("Broker linking arrives with the Flex integration.")).toBeTruthy();
  });

  it("renders the Notifications heading and the replaceable placeholder card", async () => {
    await renderApp("/profile/notifications", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Notification settings arrive with the notifications phase.")).toBeTruthy();
  });
});
```

Run: `bun run test:web -- profile-api`
Expected: FAIL (`Failed to resolve import "./profile-api"`). The other three files cannot run before Step 7 (they need the router wiring); they are expected to fail to import `@/features/profile/default` until Step 2.

- [ ] **Step 2: Implement the profile API, the singleton and the test mock**

`apps/web/src/features/profile/profile-api.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export interface Profile {
  userId: string;
  displayName: string | null;
}

const rowSchema = z.object({ user_id: z.string(), display_name: z.string().nullable() });

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(60, "Use at most 60 characters.")
  .refine((value) => !hasControlCharacter(value), "Use letters, digits and punctuation only.");

/** Own-row access through RLS and column grants (spec 6.8): only these two columns are read, only display_name is written. */
export function createProfileApi(client: Pick<SupabaseClient, "from">) {
  return {
    async getProfile(userId: string): Promise<Profile | null> {
      const { data, error } = await client
        .from("profiles")
        .select("user_id, display_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error("Could not load your profile.");
      if (data === null) return null;
      const row = rowSchema.parse(data);
      return { userId: row.user_id, displayName: row.display_name };
    },

    async updateDisplayName(userId: string, displayName: string): Promise<void> {
      const parsed = displayNameSchema.parse(displayName);
      const { error } = await client.from("profiles").update({ display_name: parsed }).eq("user_id", userId);
      if (error) throw new Error("Could not save your name.");
    },
  };
}

export type ProfileApi = ReturnType<typeof createProfileApi>;
```

`apps/web/src/features/profile/default.ts`:

```ts
import { supabase } from "@/lib/supabase";
import { createProfileApi } from "./profile-api";

export const profileApi = createProfileApi(supabase);
```

`apps/web/src/test/profile-default-mock.ts`:

```ts
import { vi } from "vitest";
import type { ProfileApi } from "@/features/profile/profile-api";

export const profileApiMock = {
  getProfile: vi.fn(),
  updateDisplayName: vi.fn(),
} satisfies Record<keyof ProfileApi, unknown>;

export const profileDefaultMock = { profileApi: profileApiMock };
```

Run: `bun run test:web -- profile-api`
Expected: PASS (about 12 cases).

- [ ] **Step 3: Implement the Security cards**

`apps/web/src/features/profile/security/google-only-card.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function GoogleOnlyCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p>
          Your account signs in with Google; there is no password to change. Manage security in your Google account.
        </p>
        <Button asChild variant="outline">
          <a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">
            Open Google account security
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/profile/security/password-card.tsx`:

```tsx
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/features/auth/components/text-field";
import { authApi } from "@/features/auth/default";
import { changePasswordSchema, fieldErrors, PASSWORD_POLICY_TEXT } from "@/features/auth/schemas";

/** Rendered only for accounts that have an email identity (SecurityPage decides). */
export function PasswordCard({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSuccess(false);
    const parsed = changePasswordSchema.safeParse({ current, password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.changePassword(email, parsed.data.current, parsed.data.password);
    setPending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setCurrent("");
    setPassword("");
    setConfirm("");
    setSuccess(true);
    toast.success("Your password was changed.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>We ask for your current password to confirm it is you.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4">
          <TextField
            id="current-password"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
            error={errors.current}
          />
          <TextField
            id="new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint={PASSWORD_POLICY_TEXT}
            error={errors.password}
          />
          <TextField
            id="confirm-password"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            error={errors.confirm}
          />
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {success ? <p role="status">Password updated.</p> : null}
          <Button type="submit" disabled={pending}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/profile/security/display-name-card.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TextField } from "@/features/auth/components/text-field";
import { profileApi } from "../default";
import { displayNameSchema } from "../profile-api";

export function DisplayNameCard({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ["profile", userId], queryFn: () => profileApi.getProfile(userId) });
  const [draft, setDraft] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (name: string) => profileApi.updateDisplayName(userId, name),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["profile", userId] });
      toast.success("Your name was saved.");
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = displayNameSchema.safeParse(draft ?? profile.data?.displayName ?? "");
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]?.message);
      return;
    }
    setValidation(undefined);
    save.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display name</CardTitle>
        <CardDescription>Shown in the app. It is not used to sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        {profile.isPending ? <Skeleton className="h-9 w-full max-w-md" /> : null}
        {profile.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              Could not load your profile.
            </p>
            <Button type="button" variant="outline" onClick={() => profile.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {profile.isSuccess ? (
          <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4">
            <TextField
              id="display-name"
              label="Display name"
              autoComplete="nickname"
              value={draft ?? profile.data?.displayName ?? ""}
              onChange={setDraft}
              error={validation}
            />
            {save.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Could not save your name.
              </p>
            ) : null}
            {save.isSuccess ? <p role="status">Name saved.</p> : null}
            <Button type="submit" disabled={save.isPending}>
              Save name
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/profile/security/sessions-card.tsx`:

```tsx
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authApi } from "@/features/auth/default";

export function SessionsCard() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  async function onConfirm() {
    // Navigate first (like the header sign-out) so the signed-out state does not bounce this page to the form.
    await router.navigate({ to: "/auth/signed-out" });
    const result = await authApi.signOut("global");
    if (!result.ok) toast.error(result.message);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          Signs you out on every device where you are signed in, including this one. The action is recorded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {confirming ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" onClick={onConfirm}>
              Yes, sign out everywhere
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            Sign out of all devices
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/profile/security/security-page.tsx`:

```tsx
import type { User } from "@supabase/supabase-js";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/features/auth/auth-provider";
import { hasPasswordIdentity, isGoogleOnly, providersOf } from "@/features/auth/identity";
import { DisplayNameCard } from "./display-name-card";
import { GoogleOnlyCard } from "./google-only-card";
import { PasswordCard } from "./password-card";
import { SessionsCard } from "./sessions-card";

const PROVIDER_LABELS: Record<string, string> = { email: "Email and password", google: "Google" };

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function EmailCard({ user }: { user: User }) {
  const verified = Boolean(user.email_confirmed_at);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>The address you sign in with. It cannot be changed here.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <p className="font-medium">{user.email}</p>
        {verified ? <Badge>Verified</Badge> : <Badge variant="outline">Not verified</Badge>}
      </CardContent>
    </Card>
  );
}

function ProvidersCard({ user }: { user: User }) {
  const providers = providersOf(user);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in methods</CardTitle>
      </CardHeader>
      <CardContent>
        <ul aria-label="Linked sign-in methods" className="list-disc space-y-1 pl-5">
          {providers.map((provider) => (
            <li key={provider}>{providerLabel(provider)}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function NoPasswordCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Password changes are not available for this account.</p>
      </CardContent>
    </Card>
  );
}

export function SecurityPage() {
  const { user } = useAuth();
  useEffect(() => {
    document.title = "Security - Stock Screener";
  }, []);
  if (user === null) return null;

  // The password form exists ONLY for accounts with an email identity (spec 11.4).
  let passwordSection = <NoPasswordCard />;
  if (hasPasswordIdentity(user)) passwordSection = <PasswordCard email={user.email ?? ""} />;
  else if (isGoogleOnly(user)) passwordSection = <GoogleOnlyCard />;

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Security
      </h1>
      <EmailCard user={user} />
      <DisplayNameCard userId={user.id} />
      {passwordSection}
      <ProvidersCard user={user} />
      <SessionsCard />
    </section>
  );
}
```

- [ ] **Step 4: Implement the layout and the Broker and Notifications shells**

`apps/web/src/features/profile/profile-layout.tsx`:

```tsx
import { Link, Outlet } from "@tanstack/react-router";
import { AuthGate } from "@/features/auth/components/auth-gate";

const SECTIONS = [
  { to: "/profile/security", label: "Security" },
  { to: "/profile/broker", label: "Broker" },
  { to: "/profile/notifications", label: "Notifications" },
] as const;

const tab =
  "inline-flex h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function ProfileLayout() {
  return (
    <AuthGate>
      <div className="space-y-6">
        <div>
          <p className="text-sm text-muted-foreground">Profile</p>
          <nav aria-label="Profile sections" className="mt-1 flex flex-wrap gap-1 border-b">
            {SECTIONS.map(({ to, label }) => (
              <Link key={to} to={to} className={tab}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <Outlet />
      </div>
    </AuthGate>
  );
}
```

`apps/web/src/features/profile/panels/broker-panel.tsx` (P5b replaces the body of this file only):

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function BrokerPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Broker linking</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Broker linking arrives with the Flex integration.</p>
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/profile/panels/notifications-panel.tsx` (P3 replaces the body of this file only):

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function NotificationsPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification settings</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Notification settings arrive with the notifications phase.</p>
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/profile/broker-page.tsx`:

```tsx
import { useEffect } from "react";
import { BrokerPanel } from "./panels/broker-panel";

export function ProfileBrokerPage() {
  useEffect(() => {
    document.title = "Broker - Stock Screener";
  }, []);
  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Broker
      </h1>
      <BrokerPanel />
    </section>
  );
}
```

`apps/web/src/features/profile/notifications-page.tsx`:

```tsx
import { useEffect } from "react";
import { NotificationsPanel } from "./panels/notifications-panel";

export function ProfileNotificationsPage() {
  useEffect(() => {
    document.title = "Notifications - Stock Screener";
  }, []);
  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Notifications
      </h1>
      <NotificationsPanel />
    </section>
  );
}
```

- [ ] **Step 5: Lint and typecheck the new files**

Run: `bun run lint:fix` then `bun run lint`
Expected: exit 0.

Run: `bun run typecheck`
Expected: exit 0 for the new files. (Until Step 7 the new components are not imported by the router; `tsc` still checks them.)

- [ ] **Step 6: Commit the files that do not depend on Task 4**

```text
git add apps/web/src/features/profile apps/web/src/test/profile-default-mock.ts
git commit -m "feat(web): add profile API, Security cards, layout and Broker/Notifications shells"
```

- [ ] **Step 7: Wire the profile into the router and run all component tests (after Task 4 is merged)**

Confirm Task 4 is merged: `git log --oneline -5` shows `feat(web): add auth routes, protected-route guard, user menu and no-store rule for auth pages`.

In `apps/web/src/router.tsx`:
1. Remove `ProfileBrokerPage`, `ProfileNotificationsPage` and `ProfileSecurityPage` from the `@/features/pages` import and add:

```tsx
import { ProfileBrokerPage } from "@/features/profile/broker-page";
import { ProfileLayout } from "@/features/profile/profile-layout";
import { ProfileNotificationsPage } from "@/features/profile/notifications-page";
import { SecurityPage } from "@/features/profile/security/security-page";
```

2. In `profileRoute` replace `component: guarded(Outlet)` with `component: ProfileLayout`, and remove `Outlet` from the `@tanstack/react-router` import if it is no longer used.
3. In `profileSecurityRoute` replace `component: ProfileSecurityPage` with `component: SecurityPage`.

In `apps/web/src/features/pages.tsx` delete the three functions `ProfileSecurityPage`, `ProfileBrokerPage`, `ProfileNotificationsPage` (the P0 placeholders).

In `apps/web/src/test/setup.ts` add below the existing `vi.mock`:

```ts
vi.mock("@/features/profile/default", async () => (await import("./profile-default-mock")).profileDefaultMock);
```

In `apps/web/src/components/app-shell.test.tsx` the `/profile` rows now render the real Security page, which loads the profile; add a default for the mocked API so the page does not log a query error (the global `afterEach` resets mocks):

```tsx
import { beforeEach, vi } from "vitest";
import { profileApi } from "@/features/profile/default";

beforeEach(() => {
  vi.mocked(profileApi.getProfile).mockResolvedValue({ userId: "user-1", displayName: null });
});
```

(merge `beforeEach` and `vi` into the existing `vitest` import).

Run: `bun run test:web`
Expected: every web test passes, including `security-page` (about 20), `profile-layout` (5) and `profile-panels` (2). Sections of the P0 `app-shell` test that render `/profile/*` now run against the real pages.

Run: `bun run lint:fix` then `bun run lint`, `bun run typecheck`, `bun run build`, `bun run check:bundle`
Expected: exit 0 each.

- [ ] **Step 8: Commit**

```text
git add apps/web/src
git commit -m "feat(web): wire profile layout and Security page into the guarded router"
```

---

### Task 6: End-to-end tests against the local Supabase stack

**Concurrency:** runs after Tasks 1 to 5 (it needs the migration, the config and the finished UI). Nothing runs beside it.

**Files:**
- Create: `tools/lib/local-supabase.ts`, `tools/lib/local-supabase.test.ts`, `apps/web/playwright.local.config.ts`, `apps/web/e2e/auth.spec.ts`
- Modify: `apps/web/playwright.config.ts`, `apps/web/package.json`, root `package.json`, root `tsconfig.json`

**Interfaces:**
- Consumes: the running local stack (`bun run supabase:start`, migrations from Task 1, config from Task 2), the Vite dev server on port 5173 (the only origin on the local redirect allow-list besides 127.0.0.1:5173), the UI from Tasks 4 and 5.
- Produces: `parseSupabaseStatus(output): { url, anonKey }`; root script `test:e2e:local`; web script `e2e:local`; spec `apps/web/e2e/auth.spec.ts` (excluded from the P0 `test:e2e` run, which serves a production build without a backend).

- [ ] **Step 1: Write the failing test for the status parser**

`tools/lib/local-supabase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSupabaseStatus } from "./local-supabase.ts";

describe("parseSupabaseStatus", () => {
  it("reads the API URL and the anon key and ignores everything else", () => {
    const output = `Stopped services: [supabase_imgproxy_x]\n${JSON.stringify({
      API_URL: "http://127.0.0.1:54321",
      ANON_KEY: "anon-key-value",
      SERVICE_ROLE_KEY: "must-never-be-returned",
      DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    })}\n`;
    const result = parseSupabaseStatus(output);
    expect(result).toEqual({ url: "http://127.0.0.1:54321", anonKey: "anon-key-value" });
    expect(JSON.stringify(result)).not.toContain("must-never-be-returned");
  });

  it("falls back to PUBLISHABLE_KEY", () => {
    const output = JSON.stringify({ API_URL: "http://127.0.0.1:54321", PUBLISHABLE_KEY: "sb_publishable_x" });
    expect(parseSupabaseStatus(output).anonKey).toBe("sb_publishable_x");
  });

  it("explains how to recover when the stack is not running", () => {
    expect(() => parseSupabaseStatus("supabase local development setup is not running")).toThrow(/supabase:start/);
  });

  it("rejects JSON without the expected keys", () => {
    expect(() => parseSupabaseStatus('{"DB_URL":"x"}')).toThrow(/API_URL/);
  });
});
```

Run: `bun run test:tools -- local-supabase`
Expected: FAIL, `Failed to resolve import "./local-supabase.ts"`.

- [ ] **Step 2: Implement the parser**

`tools/lib/local-supabase.ts`:

```ts
export interface LocalSupabase {
  url: string;
  anonKey: string;
}

/**
 * Reads the public connection values from `supabase status -o json`. The service-role key is
 * present in that output and is deliberately never read.
 */
export function parseSupabaseStatus(output: string): LocalSupabase {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("supabase status printed no JSON; is the local stack running (bun run supabase:start)?");
  }
  const data = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  const url = data.API_URL;
  const anonKey = data.ANON_KEY ?? data.PUBLISHABLE_KEY;
  if (typeof url !== "string" || typeof anonKey !== "string") {
    throw new Error("supabase status JSON has no API_URL or ANON_KEY/PUBLISHABLE_KEY");
  }
  return { url, anonKey };
}
```

Run: `bun run test:tools -- local-supabase`
Expected: PASS (4 tests). If `supabase status -o json` on CLI 2.121.0 names the keys differently, adjust the two key names here and in the test after inspecting the real output once (`bunx supabase status -o json`), keeping the "never read the service-role key" assertion.

- [ ] **Step 3: Write the Playwright configuration and the spec**

`apps/web/playwright.local.config.ts`:

```ts
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { parseSupabaseStatus } from "../../tools/lib/local-supabase.ts";

const PORT = 5173;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function localSupabase() {
  const url = process.env.E2E_SUPABASE_URL;
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY;
  if (url && anonKey) return { url, anonKey };
  const output = execSync("bunx supabase status -o json", {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseSupabaseStatus(output);
}

const supabase = localSupabase();
const inherited = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

// Auth e2e: the Vite dev server on the one origin the local allow-list knows (http://localhost:5173),
// talking to the local stack. Stop any other dev server on port 5173 first.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "auth.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...inherited,
      VITE_SUPABASE_URL: supabase.url,
      VITE_SUPABASE_ANON_KEY: supabase.anonKey,
    },
  },
});
```

`apps/web/e2e/auth.spec.ts`:

```ts
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const PASSWORD = "E2e-Passw0rd-9x";

test("sign up, use a protected page, sign out, sign in again, open Security", async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const header = page.getByRole("banner");

  // sign up (the local stack auto-confirms) and land on the Overview
  await page.goto("/auth/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await expect(header.getByRole("link", { name: "Profile" })).toBeVisible();

  // a protected page renders while signed in
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Portfolio" }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();

  // sign out
  await header.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth\/signed-out$/);
  await expect(header.getByRole("link", { name: "Sign in" })).toBeVisible();

  // a deep link to a protected page redirects, and never flashes the page
  await page.goto("/portfolio");
  await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fportfolio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toHaveCount(0);

  // sign in again lands on the original target
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();

  // Profile -> Security: email, verified badge, password form (this account has an email identity)
  await header.getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile\/security$/);
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();
  await expect(page.getByLabel("New password")).toBeVisible();
  await expect(page.getByText(/there is no password to change/)).toHaveCount(0);

  // an off-origin `next` is ignored after sign-in
  await header.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth\/signed-out$/);
  await page.goto("/auth/sign-in?next=https%3A%2F%2Fevil.example.com%2Fphish");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  expect(new URL(page.url()).hostname).toBe("localhost");
});

test("the callback renders the error state for an error response", async ({ page }) => {
  await page.goto("/auth/callback?error=access_denied&error_description=The+user+denied+access");
  await expect(page.getByRole("alert").filter({ hasText: "cancelled" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("The user denied access");
});

test("the callback ends in the error state for a code that cannot be exchanged", async ({ page }) => {
  await page.goto("/auth/callback?code=bogus-code&next=%2Fportfolio");
  await expect(page.getByRole("alert").filter({ hasText: "could not be completed" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    /\/auth\/sign-in\?next=%2Fportfolio/,
  );
});
```

Edits to existing files:
1. `apps/web/playwright.config.ts` (the P0 production-build smoke run has no backend): add `testIgnore: "**/auth.spec.ts",` to the object passed to `defineConfig`, next to `testDir`.
2. `apps/web/package.json` `scripts`: add `"e2e:local": "playwright test --config playwright.local.config.ts"`.
3. Root `package.json` `scripts`: add `"test:e2e:local": "bun run --filter @screener/web e2e:local"`.
4. Root `tsconfig.json`: extend `include` with `"apps/web/playwright.local.config.ts"` and `"apps/web/e2e/auth.spec.ts"`.

- [ ] **Step 4: Run the end-to-end tests**

Run: `bun run supabase:start` (skip if the stack is running; confirm with `bunx supabase status`).
Run: `bun run test:e2e:local`
Expected: Playwright starts `bun run dev` on port 5173 and runs 3 tests: `3 passed`. If the first test fails at sign-up with a 429 status the local rate limit (30 sign-ups per 5 minutes per IP) was hit by repeated runs; wait five minutes. If it fails at `Verified`, local auto-confirm did not set `email_confirmed_at` (UNVERIFIED for CLI 2.121.0): inspect the user in Studio (`http://127.0.0.1:54323`, table `auth.users`), then change only that assertion to match observed behaviour and record it. If the page stays on `/auth/sign-up` after submit, open the browser console in headed mode (`bunx playwright test --config playwright.local.config.ts --headed`) and check `profiles`: a failing `on_auth_user_created` trigger makes sign-up return 500 (look for `permission denied for schema app` and apply the `supabase_auth_admin` grants from Task 1 Step 4).

Run: `bun run test:e2e`
Expected: the P0 smoke tests still pass and no `auth.spec.ts` test is listed.

Run: `bun run lint:fix` then `bun run lint` and `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```text
git add tools/lib/local-supabase.ts tools/lib/local-supabase.test.ts apps/web/playwright.local.config.ts apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts apps/web/package.json package.json tsconfig.json
git commit -m "test(e2e): add auth end-to-end tests against the local Supabase stack"
```

---

### Task 7: Phase exit checklist

**Concurrency:** last; nothing runs beside it.

**Files:** none new; this task only verifies and, if the formatter or a check demands it, fixes.

- [ ] **Step 1: Run every automated gate from a clean state**

Run these in order (PowerShell, repository root; stop at the first failure and fix it in the owning task's files):

```text
bun install --frozen-lockfile
bun run lint:fix
bun run lint
bun run typecheck
bun run check:auth-config
bun run test:tools
bun run test:web
bun run supabase:reset
bun run test:db
bun run build
bun run check:bundle
bun run test:e2e
bun run test:e2e:local
```

Expected: `lint` and `typecheck` exit 0; `auth config: OK (4 redirect urls)`; tools and web tests pass; `supabase db reset` applies all migrations; `test:db` reports `Result: PASS` for `0001_smoke.test.sql`, `0300_auth_profiles.test.sql` (34 tests) and the P1 files; `build` succeeds; `bundle secret scan: OK`; both Playwright runs pass.

- [ ] **Step 2: Static checks that the constraints hold**

Run: `Get-ChildItem apps/web/src -Recurse -Include *.ts,*.tsx | Select-String -Pattern 'console\.' | Where-Object { $_.Path -notmatch '\.test\.' }`
Expected: only the two `console.warn("audit write failed", ...)` lines in `features/auth/api.ts` (they print an error code, never a token).

Run: `Get-ChildItem apps/web/src, apps/web/dist -Recurse -Include *.ts,*.tsx,*.js,*.html | Select-String -Pattern 'service_role|SERVICE_ROLE|sb_secret_|GOCSPX' | Where-Object { $_.Path -notmatch '\.test\.' }`
Expected: no output (the only test file that mentions `service_role` is `supabase.test.ts`).

Run: `Select-String -Path apps/web/src/router.tsx -Pattern 'requireAuth'`
Expected: four matches (import, `/portfolio`, `/analytics`, `/profile`).

- [ ] **Step 3: Manual checks that automation cannot cover (record each observation)**

1. **Password reset through the mail viewer (failure mode 3).** With the stack and `bun run dev` (variables from `apps/web/.env.local`: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` taken from `bunx supabase status`) running, open `http://localhost:5173/auth/reset`, request a reset for the e2e user, open `http://127.0.0.1:54324`, open the email, click the link in the same browser. Expected: `/auth/update-password` shows "Set a new password" (the `PASSWORD_RECOVERY` event arrived). Click the Portfolio link in the top navigation (client-side navigation keeps the in-memory flag): you are sent back to `/auth/update-password`. Typing a URL reloads the page and drops the flag, after which the session behaves normally (accepted, plan decision 7). Set a new password, press "Continue to the app", sign out and sign in with the new password.
2. **Audit rows.** In Studio (`http://127.0.0.1:54323`), SQL editor: `select event_type, data from public.audit_events order by id desc limit 5;` Expected: `auth.password_changed` with `{"via":"recovery"}` from step 1, no emails, tokens or passwords in `data`.
3. **Change password and sign out everywhere** from `/profile/security` for a password account; check two more audit rows (`auth.password_changed` with `via: profile`, `auth.sign_out_all`).
4. **Google-only rendering.** If a real Google OAuth client is configured in `supabase/.env`, sign in with Google using an address that has no password account and confirm Security shows the Google explanation and no password form. Otherwise record "covered by unit tests only".
5. **Hosted project (operator, when it exists).** Follow operator guide section 3; confirm that a first sign-up creates a `profiles` row (the `auth.users` trigger on hosted Supabase is UNVERIFIED) and that a non-default `next` survives the Google round trip.

- [ ] **Step 4: Commit any fixes**

If the gates required changes:

```text
git add -A apps tools supabase docs package.json tsconfig.json bun.lock
git commit -m "chore(p5a): phase exit fixes"
```

If nothing changed there is nothing to commit; record in the PR description which of the manual checks were run.

---

## Spec coverage map (self-review)

| Spec 11 item | Where |
|---|---|
| 11.1 methods and PKCE configuration, confirmations | Global Constraints; Task 2 (config, check, operator guide); Task 3 `supabase.ts` + test |
| 11.2 redirects, allow-list (production exact, local globstar), in-app `next` guard, callback exchange | Task 2 (`auth-config.ts`); Task 3 (`redirects.ts`, `completeCallback`); Task 4 (callback page, `_headers`, SW test) |
| 11.3 flows: sign-up, sign-in, Google, reset, password change with current-password check, sign-out | Task 3 `api.ts`; Task 4 pages; Task 5 `PasswordCard`; account deletion stays out of scope |
| 11.4 Google-only detection | Task 3 `identity.ts`; Task 5 `SecurityPage` |
| 11.5 session handling, route protection, `onAuthStateChange`, cache cleared on sign-out | Task 3 (`auth-store.ts`, `default.ts` clears the Query cache); Task 4 (`requireAuth`, `AuthGate`); Edge Function `getClaims()` verification is out of scope for P5a (P5b functions) |
| 11.6 rate limits and abuse posture | Global Constraints and operator guide 3.3; CAPTCHA deferred (decision 6); generic error texts (`errors.ts`); `record_audit` cap |
| 11.7 custom SMTP | Operator guide 3.3 (pointer to section 4, P3) |
| 11.8 profile pages | Task 5 (Security complete; Broker and Notifications shells) |
| 11.9 audit events (auth ones) | Task 1 RPC; Task 3 `AUDIT_EVENTS`; the broker/push events remain with their phases |
| 6.3, 6.9 profiles and audit_events RLS | Task 1 migration and pgTAP |
| 14.1 routes, 14.3 states (skeleton, error with retry, empty) | Task 4 (routes, skeleton), Task 5 (retry on profile load) |
| 15 secrets, redaction, XSS/CSRF posture | no service-role key (`supabase.test.ts`, exit grep); fixed error texts (never raw `error_description`); redaction in SQL; localStorage session accepted per spec 11.5 |
| 17 testing (pgTAP two-user, Testing Library, Playwright) | Tasks 1, 3, 4, 5, 6 |

## Items to verify when executing (UNVERIFIED at authoring time)

- Local CLI 2.121.0: `env(...)` substitution from `supabase/.env`, the Mailpit URL, `supabase status -o json` key names, whether `[auth.external.google]` exists in the generated config (Task 2, Task 6).
- supabase-js 2.117.3 internal field names asserted in `supabase.test.ts` (`flowType`, `detectSessionInUrl`, `persistSession`, `autoRefreshToken`), and the event order `PASSWORD_RECOVERY` before `INITIAL_SESSION` after a PKCE recovery link (manual check 1).
- TanStack Router 1.170.x: `router.invalidate()` re-runs `beforeLoad` (guard transition tests); `aria-current="page"` on active links (P0 test already relies on it); search serialisation `?next=%2Fportfolio`.
- Local auto-confirm sets `email_confirmed_at` (the `Verified` assertion in the e2e test).
- Hosted: trigger on `auth.users` through `supabase db push`; Supabase matching an exact allow-list entry against a URL that carries a query string (operator guide 3.2, step 5); Cloudflare applying `_headers` rules to SPA-fallback navigations.
- Not built in P5a: CAPTCHA, `getClaims()` verification in user Edge Functions, broker and notification settings.
