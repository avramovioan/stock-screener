# Invite-only sign-in, device notifications, Trade on IBKR for everyone — plan (2026-10-20)

Owner: "can I have a table in the database that I would populate manually with emails. Then the sign-in would request an email
field only. When the user enters their email - if they are part of that list - they would get a Password and Confirm password and
they can log and enter that ibkr linking functionality. But if they are not part of the list, then they should see 'not possible
yet' without many explanations as to why. ... we should still support the option to get a prompt for IBKR as we do now" and, on
approving the board: "I like the design. Do it. ... I want all the viewers to be able to subscribe their device for notification
when they are not logged in". He accepts that the first step reveals list membership and that an unclaimed invite can be claimed
by whoever types the e-mail first.

Approved board: `.superpowers/sdd/2026-10-19-ui-mockups/project/Access.dc.html` (three phones + notes; binding).

## Contracts (binding for every task)

Invite table `public.invited_emails`: `email text primary key` (stored lower-case: a trigger lower-cases and trims on insert/update),
`reset_password boolean not null default false`, `note text`, `created_at timestamptz not null default now()`. RLS on, no policies,
no grants to anon/authenticated. The owner edits it in the Supabase Table Editor.

Edge Function `account-access` (new, public, platform JWT check off like every function, CORS as the others, per-IP rate limit
10 per minute and 60 per hour via the existing rate-limit adapter):
- `POST { action: "check", email }` → 200 `{ status: "create_password" | "sign_in" | "not_possible" }`. `create_password`: on the
  list and (no auth user with that e-mail, or `reset_password` true). `sign_in`: on the list, user exists, no reset. Everything else
  (not on the list, malformed e-mail) → `not_possible`.
- `POST { action: "set_password", email, password }` → 200 `{ ok: true }` after creating the user with `email_confirm: true` (admin
  API) or updating the existing user's password and clearing `reset_password`; 400 `{ ok: false, reason: "weak_password" }`
  (fewer than 12 or more than 72 characters); 403 `{ ok: false, reason: "not_possible" }` (not on the list, or the user exists and
  no reset is pending); 429 `{ ok: false, reason: "rate_limited", retry_after_seconds }`. The client then signs in with
  `signInWithPassword`.

Push subscriptions: `push_subscriptions.user_id` becomes nullable; new `topic_discounts boolean not null default true` and
`topic_portfolio boolean not null default false` with a check that `topic_portfolio` implies `user_id is not null`.
`push-subscribe` accepts calls with or without a user JWT (an invalid JWT is treated as none); anonymous calls are rate-limited per
IP (20 per minute, as today). Actions, all keyed by the browser's `endpoint`:
- `subscribe { subscription, topics: { discounts, portfolio } }` → upsert by endpoint; with a JWT the row is bound to the user,
  without one `user_id = null` and portfolio forced false. 200 `{ ok: true, topics }`; 400 invalid input; 409
  `too_many_subscriptions` (per user as today; anonymous rows have no per-user cap).
- `update { endpoint, topics }` → same binding rule as subscribe (a call without a JWT makes the row anonymous and portfolio off).
  200 `{ ok: true, topics }`; 404 `{ error: "not_found" }`.
- `status { endpoint }` → 200 `{ subscribed: boolean, topics: { discounts, portfolio } | null }`.
- `unsubscribe { endpoint }` → 200 `{ ok: true }` (idempotent).
- `test { endpoint }` → one test push to that endpoint only, at most one per endpoint per minute. 200 `{ ok: true, sent, failed }`;
  404 `not_found`; 429 `rate_limited`.

Digests: a public "new companies on the list" digest is built once per scan run with the same selection rule as today's user
discount digest and delivered to every active anonymous subscription with `topic_discounts`. User-bound subscriptions get the
user's discount digest when `topic_discounts` and the portfolio digest when `topic_portfolio`. A device never gets the same digest
twice. Empty digests are never sent to anonymous devices.

## Global Constraints

- TDD (RED then GREEN). Touch only your task's files. Commits: conventional subject, body explains why, last line exactly
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Other agents work in the same checkout at the same time: stage with
  `git add`/`git rm` by name AND commit with `git commit -m "..." -- <your paths>` so only your paths are committed; never
  `docs/discovery/**`; on `index.lock` wait 10 s and retry. Never touch the hosted project.
- Repo-wide lint/typecheck may show other tasks' in-progress files: judge your own.

### Task 1: invite list and account-access (backend)

Files: migration `supabase/migrations/20261015009600_invited_emails.sql`, pgTAP `supabase/tests/1060_invited_emails.test.sql`, new
`supabase/functions/account-access/**` (handler + index + store + tests, following `research-request`'s structure), `supabase/config.toml`
(`[functions.account-access]` block; leave `[auth]` sign-up settings as they are unless local tests need otherwise: the hosted
switch is an owner step), `tools/check-functions-config.ts` / its function list and `tools/lib/secret-names.ts` only if they enumerate
functions or names. Admin user lookup by e-mail: use the service-role client (auth admin API) or a security-definer SQL helper on
`auth.users`, whichever the repo's patterns favour; never expose it to anon. Checks: Deno tests, `bun run functions:check`,
`bun run check:functions-config`, `bun run check:secrets`, `bunx supabase migration up` + `bun run test:db`.
Commit: `feat(auth): invite-only accounts through an e-mail list`.

### Task 2: device push without an account (backend)

Files: migration `supabase/migrations/20261015009700_device_push.sql`, pgTAP `supabase/tests/1070_device_push.test.sql`, existing
pgTAP files that pin `push_subscriptions` or the notify RPCs, `supabase/functions/push-subscribe/**`, `supabase/functions/notify-dispatch/**`,
`supabase/functions/worker-tick/handlers/digest*.ts`, `supabase/functions/_shared/core/digest.ts` (+ tests),
`tools/integration/notifications.integration.ts` only to keep it compiling. Do not change `config.toml` or tools lists (Task 1 owns
them). Checks: Deno tests, `bun run functions:check`, `bun run test:core`, `bunx supabase migration up` + `bun run test:db`.
Commit: `feat(notifications): any device can subscribe; holdings alerts stay with signed-in users`.

### Task 3: web

Files: `apps/web/src/features/auth/**` (sign-in becomes the e-mail-first flow of the board calling `account-access`; remove the
sign-up page, Google sign-in, and the e-mail password-reset/update-password pages and routes if only e-mail links used them; keep
Profile Security's change-password), `apps/web/src/router.tsx`, `apps/web/src/features/notifications/**` (the bell button in the app
header for every viewer and its sheet exactly as the board, using the push contract and the existing `push-client.ts`; the iPhone note
only on iOS when not installed), `apps/web/src/features/profile/**` (remove the Notifications panel and route; Broker and Security
stay), the app header/nav component, `apps/web/src/features/overview/discount-card.tsx` and `viewer.ts` (Trade on IBKR for every
viewer; no "Sign in to trade" / "Link IBKR in Profile"), tests, e2e specs/stubs `apps/web/e2e/**` (including `e2e/local/**` texts,
not run). Load the `frontend-design` and `ui-ux-pro-max` skills. Checks: `bun run test:web`, `bunx biome ci <files>`,
`bunx tsc -p apps/web --noEmit`, `bun run test:e2e`. Commit: `feat(web): invite-only sign-in, device notifications bell, Trade on IBKR for everyone`.

### Task 4: docs (after 1 to 3)

`docs/operator-guide.md` (invite list: how to add a friend, how to reset a password, how to remove someone: delete the row and the
auth user; turn public sign-up off on the hosted project; Google provider no longer used; anonymous device push and its limits),
`docs/cloudflare-go-live.md` (drop the Google step, keep Auth URL settings only if still needed, add "turn off sign-ups" and "add your
own e-mail to invited_emails with reset_password ticked"), `README.md`. Check `bun run check:secrets`.
Commit: `docs: invite-only access and device notifications`.
