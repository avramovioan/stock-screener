# Remove e-mail notifications — plan (2026-10-20)

Owner: "I think I will skip the emails as well. Maybe you can remove them." Context: the app is for the owner only (broker data is
not offered to others); login stays (Portfolio and Profile are private, push subscriptions belong to a user). Web Push stays the
only notification channel, with the same digests and alerts it sends today. Supabase Auth's own mails (sign-up confirmation,
password reset) are not part of this and stay as they are.

## Rulings (lead)

- Remove every e-mail path in code: Resend adapter, the e-mail channel of `notify-dispatch`, `resend-webhook`, `notify-unsubscribe`,
  the unsubscribe token, the e-mail preference UI, e-mail texts, the secrets the code reads only for e-mail (`RESEND_API_KEY`,
  `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `UNSUBSCRIBE_SECRET`, `RECIPIENT_HASH_SECRET`, `FUNCTIONS_PUBLIC_URL` if e-mail only;
  `RESEND_API_URL` test seam) and their checks.
- Database: do NOT drop tables or columns that hold data (e-mail events, delivery history, preference columns). A new forward
  migration only removes what would otherwise run or fail: e-mail-only cron jobs, e-mail-only functions/RPCs no code calls any
  more, and it turns any stored e-mail preference off. Leftover unused schema is accepted and listed in the report.
- Push must keep working end to end: same digest selection, same cut-offs, same push payloads.

## Global Constraints

- TDD where behaviour changes (push-only dispatch); deleting code deletes its tests. Touch only your task's files.
- Commits: conventional subject, body explains why, last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  stage by name; never `docs/discovery/**`. Another agent commits concurrently: on `index.lock` wait 10 s, retry.
- Never touch the hosted project. Repo-wide lint/typecheck may show the other task's in-progress files: judge your own.

### Task 1: backend and tools

Scope: `supabase/functions/**` (delete `resend-webhook/`, `notify-unsubscribe/`, `_shared/adapters/email.ts`,
`_shared/adapters/unsubscribe-token.ts` and their tests; push-only `notify-dispatch`; e-mail bits of `worker-tick` digest stage,
`retention-cleanup`, `health`, `_shared/adapters/env.ts`), `supabase/config.toml` (`[functions.*]` blocks of deleted functions),
new migration `supabase/migrations/20261015009500_remove_email.sql` + pgTAP `supabase/tests/1050_remove_email.test.sql`, existing
pgTAP files that pin removed objects, `tools/**` (secret inventory `tools/lib/secret-names.ts`, `check:functions-config` list,
integration tests under `tools/integration` for notifications: keep the push parts, drop the e-mail parts; release/verify scripts
that list functions), `.github/workflows/**` only if they name a deleted function. Checks: `bun run functions:test`,
`bun run functions:check`, `bun run check:functions-config`, `bun run check:secrets` (it reads docs/operator-guide.md: if it fails
only because the guide still names removed secrets, report that; Task 3 edits the guide), `bun run test:core`, `bun run test:tools`,
`bunx supabase migration up` + your pgTAP via psql + `bun run test:db`, `bun run test:integration:notifications` if the local stack
supports it. Commit: `refactor(notifications): push only; remove the e-mail channel and Resend`.

### Task 2: web

Scope: `apps/web/src/features/notifications/**` (remove `email-card.tsx` and every e-mail control/text; digest preferences keep
working for push), `apps/web/src/features/profile/**` (notifications panel without e-mail), any unsubscribe page/route, e-mail
mentions in `page-chrome.ts` / How-it-works / help texts, `apps/web/src/lib/database.types.ts` only if generated types must lose
removed RPCs (do not hand-edit table types that still exist), tests and e2e specs/stubs under `apps/web/e2e/**`. Keep sign-in,
sign-up and password pages. Checks: `bun run test:web`, `bunx biome ci <files>`, `bunx tsc -p apps/web --noEmit`, `bun run test:e2e`.
Commit: `refactor(web): notifications are push only; remove the e-mail settings`.

### Task 3: docs (after 1 and 2)

`docs/operator-guide.md` (go-live table, sections 2.3/2.4 secret lists, 4 becomes Web Push only, 4.4/4.5 e-mail removed, 11, 12.1,
13.2, 16 limits, any Resend mention), `docs/cloudflare-go-live.md` (step 7 removed, renumber), `README.md`, `localtest.md`. State that
the hosted secrets and the two deployed functions can be removed by the owner (commands). Check `bun run check:secrets` passes.
Commit: `docs: push-only notifications; e-mail and Resend removed`.
