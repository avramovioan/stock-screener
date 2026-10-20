# AI provider chain, no parking, reset of unfinished research — plan (2026-10-20)

Owner decisions (2026-10-20): reset every unfinished report and keep only finished ones; Scan with AI tries a chain of free
providers in order: Gemini 3.5 Flash → Gemini 3.5 Flash-Lite → Groq GPT-OSS 120B → Groq GPT-OSS 20B; when every provider is out of
daily quota the button becomes "No free AI quota left today" with Copy the prompt; when providers are only BUSY (overloaded,
per-minute limits) the card says so and offers "Try again" after a short wait. One change set, deployed once. Also the card fixes:
newest result wins, no button while work is in progress, plain cooldown wording.

Model IDs verified against both keys on 2026-10-20: `gemini-3.5-flash`, `gemini-3.5-flash-lite` (Gemini API),
`openai/gpt-oss-120b`, `openai/gpt-oss-20b` (Groq). Free limits (verify in the consoles): Groq GPT-OSS 120B 30 RPM / 1,000 RPD /
8,000 TPM / 200,000 TPD, per model; Gemini free daily limits vary by model and reset at midnight Pacific. Measured: a report takes
13–18 LLM calls and 28–34k tokens.

## Shared contract (all tasks code against exactly this)

1. **Chain setting** `app_settings.research.llm_chain`: an ordered JSON array of entries
   `{ "key": "<label>:<model>", "provider": "gemini" | "openai_compatible", "label": "gemini" | "groq", "model": "<id>",
   "base_url": "<https url>" (openai_compatible only), "max_input_tokens": int|null, "max_output_tokens": int|null,
   "reasoning_effort": "low"|"medium"|"high"|null, "quota_reset": "pacific" | "utc" }`. Defaults (migration):
   1. `gemini:gemini-3.5-flash`, provider gemini, label gemini, model `gemini-3.5-flash`, nulls, quota_reset `pacific`
   2. `gemini:gemini-3.5-flash-lite`, same with model `gemini-3.5-flash-lite`
   3. `groq:openai/gpt-oss-120b`, provider openai_compatible, label groq, base_url `https://api.groq.com/openai/v1`,
      max_input_tokens 4500, max_output_tokens 3000, reasoning_effort `low`, quota_reset `utc`
   4. `groq:openai/gpt-oss-20b`, same as 3 with model `openai/gpt-oss-20b`
   API keys stay in the existing secrets: provider `gemini` uses `GEMINI_API_KEY`; `openai_compatible` uses `LLM_ALT_API_KEY`. No new
   secrets. When the setting is absent or invalid, the worker falls back to today's env-defined pair (GEMINI_* then LLM_ALT_*).
   Research settings also gain `busy_retry_minutes` (15).
2. **Model state table** `public.llm_model_state (model_key text primary key, exhausted_until timestamptz, last_error text,
   updated_at timestamptz not null default now())`, service-role write only, no anon access. The worker upserts
   `exhausted_until` when a model answers a per-DAY quota error: next 00:00 America/Los_Angeles for `quota_reset = pacific`, next
   00:00 UTC for `utc`.
3. **Public quota status** `public.research_quota_status() returns jsonb` (security definer, `stable`, granted to anon and
   authenticated): `{ "available": bool, "next_reset_at": timestamptz|null }`. `available` is false when every chain model has
   `exhausted_until > now()` OR the day's Tavily credits are below 8 OR the visitor daily cap (`visitor_scans_per_day`) is used up;
   `next_reset_at` = the earliest time any of those clears. It exposes nothing else.
4. **Report outcomes** for `visitor` and `manual` triggers: never `quota_deferred`, never parked. Terminal failure codes in
   `research_reports.error`: `no_quota` (every chain model exhausted for the day, or Tavily out) and `providers_busy` (the chain was
   walked and the remaining models failed only with overload / per-minute limits / network). Other failures keep their existing
   codes. Monitored-holding triggers (`monitor_first`, `monitor_change`) keep today's deferral behaviour.
5. **Superseded work**: when a report completes, every other `queued`, `running` or `quota_deferred` report of the same security is
   set to `failed` with `error = 'superseded'` and its open `research` scan jobs are deleted.
6. **Feed** (`todays_discounts_feed` / `v_todays_discounts`): new column `research_failed_reason` (the newest failed report's
   `error`). The failed lateral and `research_failed_at` ignore reports whose error is `reset` or `superseded`. The in-flight lateral
   ignores in-flight reports that started before the security's newest `complete` report finished.
7. **Endpoint** `research-request`: new reason `no_quota` (429, body `next_allowed_at`), returned when
   `research_quota_status().available` is false (replaces `budget_paused`, which is still accepted by the web for old builds); a
   failed report with error `providers_busy` uses `busy_retry_minutes` (15) for `retry_later` instead of `visitor_retry_minutes`;
   a failed report with error `no_quota` does not block a new request once quota is available again.

## Global Constraints

- TDD (RED then GREEN in the report). Touch only your task's files. No docs except where stated.
- Migrations forward-only, replay-safe, house-style header, after `20261015009200`. Settings defaults `'<defaults>'::jsonb || value`.
- Commits: conventional subjects, body explains why, last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  stage only your files; never `docs/discovery/**`. Other agents commit concurrently: on `index.lock` wait 10 s and retry.
- Commands: Deno tests per file, `bun run test:core`, `bun run functions:check`, `bun run lint`, `bun run typecheck`, `bun run
  test:web`, `bunx tsc -p apps/web --noEmit`, `bunx biome ci <files>` (0 errors). Never run `supabase db reset`, `test:db`,
  integration or e2e (Task 2 may apply its migration with `bunx supabase migration up` and run its pgTAP file via psql in a
  rolled-back transaction).

### Task 1: the provider chain in the worker (backend)

Files: `supabase/functions/_shared/adapters/llm/index.ts` (+ test), `supabase/functions/_shared/adapters/research_types.ts`,
`supabase/functions/_shared/adapters/research_store.ts`, `supabase/functions/worker-tick/handlers/research_steps.ts`,
`research_seed.ts`, the worker's research deps wiring (where `createLlmProviders` is called), `handlers/testing/fake_store.ts`, and
the tests next to each (`research_fallback.test.ts`, `research_cadence.test.ts`, `research.test.ts`, `research_seed.test.ts`).

1. `createLlmChain(chainSetting, env, fetchImpl)` builds one provider per chain entry (Gemini adapter with the entry's model;
   OpenAI-compatible adapter with the entry's base URL, model, budget, reasoning effort), `name = entry.key`. Absent/invalid setting →
   today's pair. The research deps expose the ordered chain (replacing `llmOrder` of two).
2. Provider walk per LLM call: start at the report's current provider (a report keeps its provider across steps while it works),
   else the first chain model not exhausted (`llm_model_state.exhausted_until > now()` read once per step; store methods
   `exhaustedModels(nowIso)` and `markModelExhausted(key, untilIso, error)`). Per-minute limit (`rate_limited`): existing bounded
   retry (3 × 90 s) on the same model, then move to the next model. `unavailable` (overload/5xx) and `network`: move to the next model
   at once. Per-day `quota`: mark the model exhausted (reset per `quota_reset`) and move to the next. A model switch mid-report is
   recorded as today (`fallback_reason`, `step_providers`); evidence trimming follows the new model's budget.
3. Chain exhausted for `visitor`/`manual`: the report ends `failed` with `no_quota` when every model is exhausted for the day (or
   Tavily is out), else `providers_busy`; cards are updated (`applyCards`) and a `research_failed` event logged with the code. No
   `quota_deferred` and no side-channel `late` job for these triggers. Monitored-holding triggers keep today's behaviour.
4. On `complete`: supersede other in-flight reports of the same security (contract 5) via a store method.
5. Seeder: `listDeferred` resumes only reports whose trigger is `monitor_first` or `monitor_change`.
6. Tests: chain order; rate-limit retries then next model; overload skips at once; daily quota marks exhausted with the right reset
   (Pacific vs UTC, DST-safe); all exhausted → `no_quota`; overload/limits only → `providers_busy`; holdings still defer; supersede on
   complete; seeder skips visitor/manual deferred reports.

Commit(s): `feat(research): free provider chain with per-model daily exhaustion`, `fix(research): visitor scans never park; finished
work supersedes older reports`.

### Task 2: schema, reset, quota status and endpoint (backend)

Files: new migration `supabase/migrations/20261015009300_ai_provider_chain.sql`, new pgTAP
`supabase/tests/1040_ai_provider_chain.test.sql`, `supabase/functions/research-request/handler.ts`, `index.ts` (+ tests).

1. Migration: settings defaults (`llm_chain` from the contract, `busy_retry_minutes` 15); `llm_model_state` table with RLS on and no
   anon/authenticated grants; `research_quota_status()` per contract 3; feed changes per contract 6 (extend the LATEST view
   definition, keep the column guard in step, append the new column last); add `'reset'`/`'superseded'`/`'no_quota'`/
   `'providers_busy'` to any check constraint on `research_reports.error` if one exists; ONE-TIME data reset: every
   `research_reports` row with status `queued`, `running` or `quota_deferred` → `failed`, `error = 'reset'`, `completed_at = now()`,
   and delete their `scan_jobs` rows of stage `research` in status `queued`/`leased`/`failed` (match on `payload->>'report_id'` or
   `payload->>'security_id'` + trigger); guarded so a replay does nothing new (it only touches rows still in those statuses — state
   this in the header). Complete reports are untouched.
2. pgTAP: the reset turns a quota_deferred report into failed/reset and leaves a complete one; the feed shows no in-flight columns
   and no failed columns for a reset report; a newer complete report hides an older in-flight one; `research_quota_status()` is
   available with an empty state table and unavailable when all four keys are exhausted (next_reset_at = earliest); anon can call
   `research_quota_status` but cannot select `llm_model_state`.
3. Endpoint: contract 7 (`no_quota` via `research_quota_status`, `providers_busy` retry window, `no_quota` failures never block once
   available). Tests for each.

Commit(s): `feat(db): provider chain settings, model quota state, reset of unfinished research`, `feat(research): request endpoint
answers no_quota and honours the busy retry window`.

### Task 3: card states (web)

Files: `apps/web/src/features/overview/research-state.ts`, `research-panel.tsx`, `research-request-api.ts` (or its current name),
`apps/web/src/features/screening/types.ts` (`research_failed_reason`), a small hook for `research_quota_status` (in
`apps/web/src/features/screening/hooks.ts` or a new file there), and their tests; overview e2e stubs only if they assert old texts.

1. Newest result wins: a complete report (`research_completed_at`) newer than `research_started_at` decides the card (defensive; the
   server also ensures it).
2. No button while work is in progress: running and paused cards show only the status lines and Copy the prompt.
3. Done: replace "Next AI scan in N h" with "A new scan can be requested from <formatSofiaShort(completed + min_recheck_hours)>";
   once that time passes the card shows the normal "Scan with AI" button (label "Scan again with AI").
4. Failed by reason: `providers_busy` → title "AI providers are busy", line "Gemini was overloaded and the backups were at their
   limit. Try again after <time>." (time = failed_at + 15 min); button "Try again with AI" disabled until then, enabled after (a timer
   re-renders at the boundary); `no_quota` → title "No free AI quota left today", line "Copy the prompt to run the evaluation
   yourself. Free quota returns <time>." (time from `research_quota_status.next_reset_at` when known), no Scan button; any other
   failure → the existing failed state.
5. Before any click: when `research_quota_status().available` is false, every card that would offer Scan with AI shows the
   `no_quota` block instead. The status is fetched once per page view and refetched with the feed.
6. Endpoint answers: `no_quota` (and legacy `budget_paused`) → the `no_quota` block; others as today.
7. Tests for every rule above (fake timers for the busy boundary).

Commit: `feat(overview): busy vs no-quota card states, no button while scanning, plain rescan wording`.

### Task 4: run-it-yourself AI buttons and the verdict tag (web; after Task 3)

Owner approved 2026-10-20 ("I reviewed the design and I like it - do it"). Board: `.superpowers/sdd/2026-10-19-ui-mockups/project/
AiHandoff.dc.html` (read it whole; copy the four logo SVGs from it verbatim, they come from Lobe Icons static SVG 1.95.1, MIT —
note the licence in a one-line comment in the icons module). Files: `apps/web/src/features/overview/research-panel.tsx`,
`card-state.ts`, `discount-card.tsx`, new `apps/web/src/features/overview/ai-handoff.tsx` (+ `ai-icons.tsx`), their tests, overview
e2e stubs only if they assert old texts.

1. **AI buttons.** Replace the "Copy the prompt" text button everywhere on the card with the board's row: label "Or run the
   evaluation in your own AI", four 44×44 icon buttons — ChatGPT, Claude, Grok, Gemini — a 1px divider, and a Copy icon button.
   Each AI button: (a) writes the full prompt (`buildResearchPrompt`) to the clipboard, (b) opens a new tab: ChatGPT
   `https://chatgpt.com/?q=<encoded>`, Claude `https://claude.ai/new?q=<encoded>`, Grok `https://grok.com/?q=<encoded>`, Gemini
   `https://gemini.google.com/app` (no prefill); open with `window.open(url, "_blank", "noopener,noreferrer")` synchronously in
   the click handler (popup blockers), clipboard write in the same handler; when the encoded URL exceeds 8,000 characters open the
   site's plain new-chat URL instead (prompt still on the clipboard); (c) shows a toast: "Prompt copied and <Name> opened in a new
   tab. If the message box is empty, paste with Ctrl+V." (Gemini: "Prompt copied and Gemini opened in a new tab. Paste it with
   Ctrl+V."). Copy button: clipboard only, toast "Prompt copied." Accessible names: "Open the prompt in ChatGPT|Claude|Grok",
   "Open Gemini with the prompt copied", "Copy the prompt"; `title` = the product name. The row shows in every research state
   (not scanned, running, paused, done, failed, busy, no quota) — it replaces the old copy button wherever that appeared.
2. **Verdict tag** next to the ticker in the card header (desktop and phone), small pill per the board:
   - **Strong buy** (green): research is done and current (≤ 30 days) AND the card is cleared (green) AND (`is_top10` OR
     `reached_line4`).
   - **Consider** (teal accent): done, current, cleared (green), not top 10, not reached −4; ALSO any done card that is "cleared
     with caution" (amber), whatever its rank or line (lead ruling: caution caps at Consider).
   - **Avoid** (red): the card is flagged (not cleared, inconclusive/insufficient evidence, withheld) — `cardState(row) ===
     "flagged"`.
   - **Unchecked** (grey): everything else — not scanned, running, paused, failed, busy, no quota, or a report older than 30 days.
   Implement as a pure `verdictTag(row, researchView)` in `card-state.ts` with a table-driven test covering every branch (MCD-like:
   rank 97, reached −4, green → Strong buy; top-10 green, −3 only → Strong buy; rank 114, −3 only, green → Consider; amber top-10 →
   Consider; red → Avoid; grey → Avoid; not scanned → Unchecked; stale 31-day green → Unchecked).
3. **No duplicate "Strong buy".** The tag under the gauge no longer says "Strong buy": every unflagged card shows the factual
   "Reached −4" or "Wait for −4" there; flagged cards still show none.
4. Tests for both items (clipboard and `window.open` mocked; URL encoding; the 8,000-character fallback; toasts; tag table).
   Run `bun run test:web -- overview`, then the whole `bun run test:web`, `bunx biome ci <files>` (0 errors),
   `bunx tsc -p apps/web --noEmit`. Load `frontend-design` first.

Commit(s): `feat(overview): run the evaluation in ChatGPT, Claude, Grok or Gemini`, `feat(overview): verdict tag in the card
header`.

**Task 4, item 5 (owner, 2026-10-20): drop the Flagged section.** The Overview no longer renders a separate "Flagged" heading/group:
flagged cards join the one grid, sorted after the others (keep today's order otherwise), with the red **Avoid** tag in the header.
They keep their reason sentence in the body (the existing flagged sentence) and the card's normal white surface (no muted
background). Remove the section, its heading and any count or copy that refers to it (`todays-discounts.tsx`,
`use-discount-groups.ts`, `sort-discounts.ts`, the overview heading sentence if it mentions flagged cards); update tests and e2e
stubs that assert the section.

**Task 4, item 6 (lead ruling on a Task 3 concern):** a card whose last report failed with `no_quota` shows the normal "not scanned"
state with the Scan with AI button as soon as `research_quota_status().available` is true; while it is false it shows the no-quota
block (contract 7).
