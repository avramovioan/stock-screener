# Scan with AI, live and shared — plan (2026-10-20)

Owner, after clicking Scan with AI on INTU (the request was accepted, the card then showed a disabled button and "can't scan",
the report finished in about a minute and only a page refresh showed it): "add some loading animation ... to tell them that a scan
is ongoing. And when it's completed, we should update the card on the spot. And if we can't perform the scan now - then we say that
they should try later." Then, approving the mockup: "The design is what I like. Do it. And can we make somehow this part be actually
synced? Let's say that 10 users clicks on the scan. The first one should trigger it and the rest should directly get the 'Scanning'.
... Make it concurrent between all the users. And if a user has loaded the page already and wants to scan it, but by that time
another person had already scanned it and there is a report - then we should ... just refresh the card with the new report."

Approved board: `.superpowers/sdd/2026-10-19-ui-mockups/project/ScanLive.dc.html` (four states + toast + notes; binding).

## Contract between the tasks (binding for both)

`POST /functions/v1/research-request` `{ security_id }`:
- 200 `{ ok: true, report_id: string | null, started_at: string }` — accepted. Task 1 makes the in-flight report row exist at this
  moment (status `queued`), so `report_id` is a string from then on; the web keeps accepting null.
- 409 `{ ok: false, reason: "in_flight", started_at: string | null, requested_by: "visitor" | "owner" | "system" | null }` — a
  scan for this company is already queued or running (anyone's). New fields: the in-flight report's start (or queue) time and who
  asked (same mapping the feed uses for `research_requested_by`).
- 429 `cooldown` (a complete report inside the 72 h window; `next_allowed_at`), the other refusals: unchanged.
- The feed (`todays_discounts_feed`) shows a queued visitor report as in flight (research_started_at = its queue time,
  research_requested_by = visitor) the moment the 200 is sent.
- Realtime: `public.research_reports` is in the `supabase_realtime` publication; anon may receive the rows anon can already select.

## Global Constraints

- TDD (RED then GREEN in the report). Touch only the files your task lists. No documentation edits except where a task says so.
- Commits: conventional subject, body explains why, last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  stage only your files by name; never `docs/discovery/**`. Another agent commits concurrently: on `index.lock` wait 10 s, retry.
- Never run `supabase db reset` against anything but the local stack; never touch the hosted project.

### Task 1: one scan per company, visible to everyone at once (backend)

Files: `supabase/functions/research-request/**`, `supabase/functions/scan-control/actions/research_now.ts` (+ test), the research
store/adapters and worker research handlers only as needed to reuse a pre-created report (+ tests), new migration
`supabase/migrations/20261015009400_research_live.sql`, new pgTAP `supabase/tests/1040_research_live.test.sql`, existing pgTAP files
that pin the schema if they break.

1. Atomic single flight: two visitor requests for the same company at the same moment must produce exactly one accepted scan; every
   later request while it is queued or running gets 409 `in_flight`. Enforce it in the database (a partial unique index on the
   in-flight visitor/manual report per security, or an advisory-locked security-definer function that checks and inserts in one
   transaction; choose after reading `20261015002000_research_schema.sql`, the supersede logic and how monitor reports coexist).
   The handler's existing order of checks stays; the final enqueue is the atomic step and maps a lost race to 409.
2. At acceptance create the report row (status `queued`, trigger `visitor`, the key the worker already uses, `started_at` or the
   field the feed reads as start = accepted time) together with the job, and make the worker reuse that row instead of creating a
   second one. `report_id` in the 200 is then that row's id.
3. 409 body carries `started_at` and `requested_by` of the in-flight report (contract above).
4. Migration also adds `public.research_reports` to the `supabase_realtime` publication (idempotent: only when not already a
   member) and confirms anon's select policy covers the columns the web reads; no new grants beyond what anon reads today.
5. Tests: handler tests for the new 409 body and the 200 report id; a pgTAP test proving the second concurrent insert/claim for the
   same security is refused while the first is in flight, that a complete report frees it, that monitor reports are unaffected, and
   that the publication contains the table; the worker reuses the pre-created row (Deno test).
6. Run: `deno test -A --config supabase/functions/deno.json supabase/functions` (all), `bun run functions:check`, `bun run lint`,
   `bun run typecheck`; pgTAP: `bunx supabase migration up` on the local stack, then your file via `psql` in a rolled-back
   transaction, then `bun run test:db` (all files).

Commit: `feat(research): one scan per company at a time, visible to everyone the moment it is accepted`.

### Task 2: live scan states on every open page (web)

Files: `apps/web/src/features/overview/research-panel.tsx` (+ tests), `research-state.ts` (+ test), `card-notes.tsx` and `discount-card.tsx` (+ tests),
`apps/web/src/features/screening/research-request-api.ts` (+ test), `apps/web/src/features/screening/hooks.ts` (+ test), a new
`apps/web/src/features/screening/use-research-live.ts` (+ test), the place the Overview mounts it, `apps/web/public/_headers` and
`tools/render-headers.ts` / `tools/check-headers.ts` only for the websocket origin (+ their tests), e2e stubs/specs under
`apps/web/e2e/**`. Load the `frontend-design` and `ui-ux-pro-max` skills.

1. States exactly as the board: Starting (spinner in the button, "Starting…", disabled only while the request is on its way);
   Scanning (pulsing dot, indeterminate moving bar with `role="progressbar"` and no `aria-valuenow`, "Started <relative> by a
   visitor. Usually a few minutes. This card updates by itself when it is done." — "Waiting to start." when there is no start
   time; no Scan button, Copy the prompt stays); Finished in place (the card renders the done state; a 2-second teal outline on the
   card; one toast "AI research for <ticker> is ready." with an "Open report" action, only for a scan this page saw in flight);
   Could not start (`try_later` and unreadable answers: title "Couldn't start the scan right now", line "Something went wrong on our
   side. Please try again in a few minutes.", an enabled "Try again" button). Motion off under `prefers-reduced-motion`. Replace
   "usually 15 to 40 minutes" with "usually a few minutes" everywhere the card says it. Paused, busy, no-quota and limits states
   keep their texts.
2. Shared and concurrent: 409 `in_flight` shows Scanning at once (using the 409's `started_at`/`requested_by`) and refetches the
   feed; 429 `cooldown` (someone else finished a report meanwhile) refetches the feed and shows the finished card in place, no
   error. The click outcome only bridges until the feed catches up (existing rule).
3. Live updates: `use-research-live` subscribes once per Overview to Realtime `postgres_changes` (insert and update) on
   `public.research_reports` with the existing supabase client, and on any event invalidates the discounts feed and the research
   quota (debounced 1 s). Unsubscribe on unmount. If the channel fails, nothing breaks. Fallback polling in `useTodaysDiscounts`:
   every 15 s while any row of the feed is in flight or a scan was accepted on this page in the last 2 minutes, else the current
   5 minutes; still only while the tab is visible.
4. CSP: `connect-src` must also allow the websocket origin of `VITE_SUPABASE_URL` (`wss://<host>`); extend the placeholder
   rendering and its check, never hard-code the host.
5. Backup-model note (owner, same day: "Researched by GPT-OSS 120B, 4 hours ago - I like it. ... the informational [sentence] ... be
   redundant. Can we make this informational icon next to the label. And for regular scan with Gemini just show nothing."): in
   `apps/web/src/features/overview/card-notes.tsx` the `Provenance` line gets, only when `fallbackSentence(row)` is non-null, an ⓘ
   button right after the text (`aria-label="Why the backup model was used"`, 22 px, 44 px touch target on phones) opening a small
   popover with that sentence (reuse the popover primitive the Overview cards' other ⓘ boxes use). `FallbackInfo` (the tinted box)
   is no longer rendered on the card (`discount-card.tsx`); remove it if nothing else uses it. A Gemini report shows no ⓘ. Tests in
   the card-notes / discount-card tests.
5b. Flagged cards look like every other card (owner: "on the flagged RMS card - you have removed the price slider. Can we have the
   card design the same, no matter if the company is flagged to be avoided. We just add different tags. I don't want my cards to be
   overwhelmed"): in `discount-card.tsx` a flagged card renders the same blocks as a cleared one: the EUR line, the `ChannelGauge`
   (not `flaggedSentence`), the `DiscountTagBlock`, the `StateBlock` in the cleared layout (state pill "Flagged: <label>" with its
   existing tone, then the summary or reason sentence in normal text without the "Not a cleared discount." prefix and without the
   muted red colour, `Verdict` if the cleared layout shows it, provenance, `ReportLink` not muted), the same footer border and the
   Trade control as a cleared card. Only the tags differ (Avoid verdict pill + Flagged state pill). Remove `flaggedSentence` if it
   becomes unused. Update the card tests and any e2e spec that asserted the flagged layout.
6. Tests: each state's texts and controls; 409 → scanning with the given start; 429 cooldown → refetch and done; try_later → Could
   not start with an enabled button; the toast only after an in-flight → done transition seen on the page; poll interval switch;
   the live hook invalidates on an event and cleans up; CSP render/check with wss. e2e: update stubs to the contract, one spec for
   in_flight → Scanning.
7. Run: `bun run test:web`, `bunx biome ci <files>`, `bunx tsc -p apps/web --noEmit`, `bun run test:tools` if the header tools
   changed, then `bun run test:e2e` from the root.

Commit: `feat(overview): live Scan with AI states shared by every open page`.
