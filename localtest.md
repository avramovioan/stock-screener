# Run the screener on another Windows PC

Goal: view the web app locally (`http://localhost:5173`) against the HOSTED Supabase project `pkfptuwwgyvjxvumqika`.
Optional: run the full local stack for tests (step 6). Commands are PowerShell. Replace `<...>` placeholders; never paste real
secrets into this file, chat or git.

## 0. On THIS PC first

Push the branches and the tag so the other PC can clone:

```powershell
git push -u origin build/initial master --tags
```

Then carry the git-ignored secret files over. They match `.env*` in `.gitignore`, so git will never move them:

| File (repo-relative) | What it holds | Needed for |
|---|---|---|
| `apps/web/.env.local` | `VITE_*` values of the hosted project | step 4 (viewing the app) |
| `supabase/functions/.env.production` | the function secrets, including the Groq `LLM_ALT_*` lines | step 5 (deploys) |
| `supabase/functions/.env` | local test stack, throw-away fixture values | step 6 only; can be recreated (see 6.2) |
| `supabase/functions/.env.vapid` | VAPID keys (optional) | only if you must re-read or re-set them |

Rules:

- Copy them with a password manager or a USB stick. Never by e-mail, chat or git.
- The VAPID private key and `FLEX_ENC_KEY_V1` must stay identical on every machine. A different `FLEX_ENC_KEY_V1` makes the stored
  IBKR token unreadable. A different VAPID key invalidates every push subscription. Never regenerate them for convenience.
- Delete the USB copy when you are done.

## 1. Install the prerequisites on the other PC

Open PowerShell and run:

```powershell
winget install --id Git.Git -e
winget install --id Oven-sh.Bun -e --version 1.3.14
winget install --id OpenJS.NodeJS -e --version 22.13.1
winget install --id Docker.DockerDesktop -e
```

Close and reopen PowerShell, then check:

```powershell
git --version
bun --version        # 1.3.x (this PC: 1.3.14)
node --version       # v22.13.1 or newer (package.json engines: >=22.13.1; .node-version pins 22.13.1)
```

Notes:

- If winget has no exact Node 22.13.1, take the latest Node 22 from https://nodejs.org/en/download (22.13.1 or newer works).
- Downloads: Git https://git-scm.com/download/win, Bun https://bun.sh, Docker Desktop https://www.docker.com/products/docker-desktop/.
- Docker is only needed to deploy Edge Functions (the CLI bundles them in a container) and for the local stack (step 6).
  Viewing the app (step 4) does not need Docker.
- Supabase CLI: nothing to install. It is a dev dependency, run it as `bunx supabase ...` after `bun install`.
- Deno 2.x is NOT bundled. `functions:check`, `functions:test`, `test` and `verify:all` call `deno` directly, so only for those
  install it once: `npm i -g deno`, then `deno --version`. Not needed for viewing or deploying.

## 2. Clone, check out and install

```powershell
git clone https://github.com/avramovioan/personal-stock-screener.git
cd personal-stock-screener
git checkout build/initial
bun install
```

## 3. Put the secret files back at their exact paths

From the repository root, copy each file to the same relative path:

```text
apps/web/.env.local
supabase/functions/.env.production
supabase/functions/.env           (optional now, see 6.2)
supabase/functions/.env.vapid     (optional)
```

Check they exist, and that git does not list them:

```powershell
Test-Path apps/web/.env.local, supabase/functions/.env.production
git status --short      # must print nothing about these files
```

If `apps/web/.env.local` is missing, create it from `apps/web/.env.example` with the hosted values: `VITE_SUPABASE_URL`
(`https://pkfptuwwgyvjxvumqika.supabase.co`), `VITE_SUPABASE_ANON_KEY` (Dashboard, Project Settings, API keys, the anon key),
`VITE_SITE_URL`, `VITE_VAPID_PUBLIC_KEY`. These are public build-time values, not secrets.

## 4. View the app against the hosted project

Link the CLI (only needed for deploys in step 5; skip it if you only want to look at the app):

```powershell
bunx supabase login
bunx supabase link --project-ref pkfptuwwgyvjxvumqika
```

Allow the local address in the hosted Auth settings (once): Supabase Dashboard, Authentication, URL Configuration. Add
`http://localhost:5173/**` to Redirect URLs. Without it, Google sign-in and password-reset links go to the wrong host.
E-mail and password sign-in works without it.

Start the dev server and open the app:

```powershell
bun run dev
```

Open `http://localhost:5173`. Vite reads `apps/web/.env.local`, so the app talks to the hosted project. If you edit that file,
stop the server (Ctrl+C) and start it again.

## 5. Deploy changes from that PC (order matters)

Docker Desktop must be running for the functions deploy. Run these in this order:

```powershell
bunx supabase db push --dry-run                      # read the list first
bunx supabase db push
bunx supabase secrets set --env-file supabase/functions/.env.production --project-ref pkfptuwwgyvjxvumqika
bunx supabase functions deploy --project-ref pkfptuwwgyvjxvumqika
```

Why this order:

1. `db push` first. The new functions write new columns. Functions deployed before the migrations fail on the missing columns.
2. `secrets set` second. New code can read new secret names (for example the Groq `LLM_ALT_*` values). The secrets must exist
   before the code that needs them runs.
3. `functions deploy` last, and always deploy ALL functions (no function name), so the shared code is the same everywhere.

If the dry run lists migrations older than the latest remote one, read the list, then use `db push --include-all`
(operator guide 2.2). After the first-ever `db push`, expose schema `app` in the Dashboard (operator guide 2.2a).

## 6. Optional: run the full local test stack

### 6.1 Start Docker and the stack

Start Docker Desktop and wait until it says "running". Port 5173 must be free (stop any `bun run dev`), because
`test:e2e:local` starts its own dev server there.

```powershell
npm i -g deno                  # once, see step 1
bun run supabase:start         # local Supabase stack in Docker
```

### 6.2 Local files (skip `supabase/functions/.env` if you copied it over)

```powershell
Copy-Item supabase/.env.example supabase/.env
Copy-Item supabase/functions/.env.example supabase/functions/.env
```

Edit `supabase/functions/.env`. All values are throw-away and must NOT be reused on the hosted project (operator guide 0.2):

- `JWT_ISSUER=http://127.0.0.1:54321/auth/v1` (required locally, never set on the hosted project)
- `RATE_LIMIT_SALT=<random string, 32 characters or more>`
- `FLEX_ENC_KEY_V1=<base64 of 32 random bytes>` and `FLEX_ENC_KEY_CURRENT=1`
- VAPID: `bun run gen:vapid -- mailto:you@example.com --out supabase/functions/.env.vapid`, then copy the three `VAPID_*` lines in
- Leave `GEMINI_*`, `TAVILY_API_KEY` and `JINA_API_KEY` empty.

For the local web app, point `apps/web/.env.local` at the local stack (URL and anon key come from the `supabase start` output).
Keep a copy of the hosted version of that file before you overwrite it.

### 6.3 Run the suites

Start `bun run supabase:serve` in a second terminal for the integration suites. Then, from the repository root:

```powershell
bun run verify:all             # every suite, one at a time, evidence in docs/discovery/p7-evidence/
```

Or the individual scripts:

```powershell
bun run lint
bun run typecheck
bun run test                   # core, tools, web, plus the Deno function tests
bun run functions:check        # deno check
bun run test:db                # pgTAP; needs an empty DB: run `bun run supabase:reset` after integration runs
bun run test:integration       # fixture scan, research, notifications, broker (stack + supabase:serve running)
bun run test:e2e:local         # Playwright against the local stack; port 5173 must be free
bun run test:e2e               # production build with real headers
bun run build
```

Local cron caveat: the local `pg_cron` minute tick can collide with fixture scans, mostly between 07:00 and 11:59 UTC. The
integration tool pauses local cron jobs during its run.

Stop the stack when finished: `bun run supabase:stop`.

## 7. Useful operator commands (hosted)

Read the secret from the file instead of typing it. This reads only the `CRON_SHARED_SECRET` line:

```powershell
$ref = "pkfptuwwgyvjxvumqika"
$secret = ((Get-Content supabase/functions/.env.production | Where-Object { $_ -match '^CRON_SHARED_SECRET=' }) -replace '^CRON_SHARED_SECRET=','').Trim('"')
$h = @{ "x-cron-secret" = $secret }
function Invoke-Scan($body) { Invoke-RestMethod -Method Post -Uri "https://$ref.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body $body }
```

Then:

```powershell
Invoke-Scan '{"action":"status"}'                     # add "run":"YYYY-MM-DD" (or a uuid) for another run
Invoke-Scan '{"action":"list_failures"}'              # failed and dead jobs with last_error

# Re-run research for one security (uuid from the securities table); "force":true re-runs a failed report
Invoke-Scan '{"action":"research_now","security_id":"<security uuid>","force":true}'

# Identity overrides: kind, yahoo_symbol and reason (3 characters or more) are required
Invoke-Scan '{"action":"override","kind":"exclude","yahoo_symbol":"<SYMBOL>","reason":"not a common share"}'
Invoke-Scan '{"action":"override","kind":"force_canonical","yahoo_symbol":"<SYMBOL>","reason":"main listing of the company"}'
```

Other `kind` values: `force_us`, `force_not_us`, `merge_into_company` (also needs `target_company_id`), `predecessor_continuity`.
An override takes effect at the next scan. More actions (`start`, `requeue`, `recompute`, `set_setting`): operator guide section 7.

## 8. Troubleshooting

- **The profile page shows a load error.** The migrations are not pushed yet, so tables or columns the app reads do not exist.
  Run `db push` (step 5), then reload.
- **Only some functions look updated after a deploy.** A partial deploy leaves mixed shared code. Redeploy all of them:
  `bunx supabase functions deploy --project-ref pkfptuwwgyvjxvumqika` (no function name), with Docker running.
- **"Research failed" on a report.** Old function code produced it. After a full redeploy, run `research_now` with `"force":true`
  for that `security_id` (step 7). The worker needs about 15 to 40 minutes.
- **Port 5173 is busy.** Another `bun run dev` or a leftover Vite process holds it. Find and stop it:
  `Get-NetTCPConnection -LocalPort 5173 | Select-Object OwningProcess`, then `Stop-Process -Id <pid>`. Otherwise Vite picks
  another port, which the Auth redirect list does not allow, and `test:e2e:local` needs exactly 5173.
- **The list is not published.** A scan publishes only when 95% or more of the candidates were processed. Below that the site shows
  the last good list and a coverage panel. Check `status` and `list_failures` (step 7), then `requeue` the run.
- **A rule change shows no effect yet.** Rules apply to the next scan, not the stored one. The first scan with the new listing
  rule runs at the next scheduled scan (10:00 Sofia). To see it sooner, start one with `{"action":"start","provider_mode":"live"}`
  on a weekday afternoon.
- **`supabase start` or a local push complains about migration history.** Run `bunx supabase db reset` once (local only).
- **A user-JWT function answers 401 locally.** `JWT_ISSUER` is missing in `supabase/functions/.env` (step 6.2).
- **"Scans are paused for now" on a card.** The public Scan with AI button shows this when the day's visitor cap
  (`visitor_scans_per_day`, 8 accepted requests per UTC day) or the AI or Tavily budget is spent, or when no LLM provider is
  configured. It clears by itself on the next UTC day or when budget returns. As the owner you can still force one company:
  `Invoke-Scan '{"action":"research_now","security_id":"<security uuid>","force":true}'` (step 7). The visitor limits do not
  apply to `research_now`; the free-quota guards still do.
