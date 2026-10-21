# Go-live runbook: tonight, start to finish

Follow the parts in order. Tick each box when the step works. Every step says what to do, where to click or what to type, and how to check it.
The long reference is `docs/operator-guide.md`. Parts link to its sections for depth.

Rules for this file:

- Run every command from the repository root, in PowerShell.
- `<placeholders>` are values you fill in. Never paste a real secret into a chat, a commit or a file in the repository.
- Portal labels were checked against the official docs on 2026-10-20. Where a label could not be confirmed, the step says what the control does instead.

## 0. Before you start

### 0.1 What to have ready

- [ ] A PowerShell terminal in the repository root (`C:\Data\git_repos\_tests\nira\personal-stock-screener`).
- [ ] Docker Desktop running (the functions deploy needs it).
- [ ] A browser logged in to Supabase, Cloudflare and GitHub. Resend too, for one cleanup step in Part A.
- [ ] Your iPhone, iPad and Android phone nearby (Part H).
- [ ] `apps/web/.env.local` open in an editor. It holds the Supabase URL, the anon key and the public VAPID key you copy in Part D.
- [ ] `bunx supabase login` already done on this computer. If `bunx supabase projects list` fails, run `bunx supabase login` first.

### 0.2 Rough time

| Part | What | Time |
|---|---|---|
| A | Backend on Supabase | 20 min |
| B | Supabase dashboard (sign-ups, providers, your invite) | 10 min |
| C | Cloudflare account, token, address | 15 min |
| D | GitHub settings | 15 min |
| E | Push the code and watch the deploys | 20 min |
| F | Point the backend at the site | 10 min |
| G | First sign-in | 5 min |
| H | Notifications on each device | 30 min |
| I | Keep-alive job | 10 min |
| J | Final checks | 15 min |
| K to N | Friends, afterwards, optional parts | as you like |

### 0.3 Current state (checked 2026-10-20)

| Thing | State now | After this runbook |
|---|---|---|
| Supabase project | `pkfptuwwgyvjxvumqika`, migrations applied through `20261015009400` | through `20261015009700` |
| Pending migrations | `20261015009500` (e-mail removal), `20261015009600` (invite list), `20261015009700` (device push) | applied (Part A) |
| Edge Functions | last deployed 2026-10-20 13:06 UTC, before the e-mail removal, invite and device-push code | redeployed; new function `account-access` exists |
| Old functions `resend-webhook`, `notify-unsubscribe` | still on the hosted project | deleted |
| E-mail function secrets | still set | unset |
| `app` schema on the hosted Data API | already exposed | nothing to do |
| `SITE_URL` function secret | the local address | the workers.dev address, plus `EXTRA_ALLOWED_ORIGINS` |
| GitHub `origin/master` | 128 commits behind `build/initial` | same commit as `build/initial` |
| Local `master` (`c24870e`) | behind `build/initial` | fast-forwarded |
| Cloudflare site | not deployed | `https://stock-screener.<your-subdomain>.workers.dev` |
| Accounts | invite-only through the table `invited_emails` | your e-mail invited, you have a password |

What you get: the site on `https://stock-screener.<your-subdomain>.workers.dev`. It is free and always on. Supabase stays where it is.
Preview URLs are off, so the site has exactly one public address.

## A. Backend on Supabase

Do A1 and A2 back to back. The new functions expect the new tables, and the old functions do not understand the new rows (operator guide 2.2).

### A1. Apply the pending migrations

- [ ] Preview first.

```powershell
bunx supabase db push --dry-run
```

It must list exactly `20261015009500`, `20261015009600` and `20261015009700`. If it lists something else, stop and read the list. If it
says migrations are older than the latest remote one, read operator guide 2.2 about `--include-all`.

- [ ] Apply them.

```powershell
bunx supabase db push
```

Check: a second `bunx supabase db push` says the remote database is up to date.
`20261015009500` turns every stored e-mail preference off and skips pending e-mail deliveries. That is intended.

### A2. Deploy every Edge Function (Docker Desktop running)

- [ ] Run it right after A1.

```powershell
bunx supabase functions deploy --project-ref pkfptuwwgyvjxvumqika
```

Check: the command ends without an error. Supabase Dashboard, Edge Functions, lists `account-access` and every function shows a fresh
"Updated" time.

### A3. Delete the two old functions

- [ ] Delete them. The command deletes from the hosted project only. Your local files stay (the CLI docs say it "does NOT remove the Function locally").

```powershell
bunx supabase functions delete resend-webhook --project-ref pkfptuwwgyvjxvumqika
bunx supabase functions delete notify-unsubscribe --project-ref pkfptuwwgyvjxvumqika
```

If the CLI asks for confirmation, answer yes. (The CLI reference does not say whether it asks. `--yes` answers yes to every prompt.)
Check: the Edge Functions list in the dashboard no longer shows them.

### A4. Unset the e-mail secrets

- [ ] Run the single command from operator guide 4.7.

```powershell
bunx supabase secrets unset RESEND_API_KEY RESEND_WEBHOOK_SECRET EMAIL_FROM UNSUBSCRIBE_SECRET RECIPIENT_HASH_SECRET FUNCTIONS_PUBLIC_URL RESEND_API_URL --project-ref pkfptuwwgyvjxvumqika
```

The CLI reference does not say what happens when a name does not exist. If the command errors on a missing name, run them one at a time:

```powershell
foreach ($n in "RESEND_API_KEY","RESEND_WEBHOOK_SECRET","EMAIL_FROM","UNSUBSCRIBE_SECRET","RECIPIENT_HASH_SECRET","FUNCTIONS_PUBLIC_URL","RESEND_API_URL") {
  bunx supabase secrets unset $n --project-ref pkfptuwwgyvjxvumqika
}
```

- [ ] Check.

```powershell
bunx supabase secrets list --project-ref pkfptuwwgyvjxvumqika
```

None of the seven names may appear. The list shows names and digests only, never values.

### A5. Resend cleanup (browser)

Do this only if you still have a Resend account from the e-mail days.

- [ ] Resend Dashboard, Webhooks. Open the webhook that points at `resend-webhook` and delete it. (Resend's docs do not describe the delete control. Look for a delete or remove action in the webhook's menu or detail page.)
- [ ] Resend Dashboard, API Keys. Open the "More options" (three dots) menu of the key used by this project and choose "Remove API key".

Check: both lists no longer show the project's items.

### A6. Backend health

- [ ] Call the health function. It needs no secret.

```powershell
curl.exe -s https://pkfptuwwgyvjxvumqika.supabase.co/functions/v1/health
```

Check: the answer contains `"ok": true`. If it says `app_schema_not_exposed`, see operator guide 2.2a (this should not happen, the schema is already exposed).

## B. Supabase dashboard

Open https://supabase.com/dashboard, then your project `pkfptuwwgyvjxvumqika`. Background: operator guide 3.

### B1. Public sign-up off, Google off, Email on

- [ ] Authentication, Sign In / Providers.
- [ ] Turn OFF "Allow new users to sign up". Save if the page shows a Save button.
- [ ] Open the Google provider and switch it off. Nothing uses it any more. (The docs name the "Sign In / Providers" page but not the exact Google toggle. Open the Google row and use its enable switch.)
- [ ] Open the Email provider and make sure it is enabled. Password sign-in needs it. Leave "Confirm email" as it is, because accounts are created already confirmed.

Check: reload the page. Sign-up is off, Google is off, Email is on. The invite flow still works, because it creates users through the admin API.

### B2. Invite your own e-mail

Your old account came from Google and has no password. The tick on `reset_password` lets you set one.

- [ ] Table Editor, open the table `invited_emails` (schema `public`), then Insert, Insert row. (The docs do not describe the insert button. It is the green Insert control at the top of the table view.)
- [ ] `email`: your address. Tick `reset_password`. `note`: anything, for example `owner`.
- [ ] Save.

If the Table Editor gives you trouble, use the SQL Editor instead:

```sql
insert into public.invited_emails (email, reset_password, note)
values ('<your e-mail>', true, 'owner');
```

Check: the table shows your row with `reset_password` ticked. The e-mail is lower-cased automatically.

### B3. Optional: clean up Google Cloud

Only if you created an OAuth client for Google sign-in earlier. It is no longer used, so deleting it is housekeeping, not a requirement.

- [ ] https://console.cloud.google.com, APIs & Services, Credentials. Delete the OAuth 2.0 client ID you made for this project. (Not verified against the current Google console labels.)

## C. Cloudflare

### C1. Account

- [ ] Sign up or log in at https://dash.cloudflare.com. The Free plan is enough.

### C2. workers.dev subdomain

- [ ] Open Workers & Pages. If this is your first time, Cloudflare asks you to pick your workers.dev subdomain. Pick it once. It becomes part of every address.
- [ ] If you already had one, it is shown next to "Your subdomain". "Change" lets you rename it.

Write it down. Your site address is:

```text
https://stock-screener.<your-subdomain>.workers.dev
```

Check: you can read your subdomain on the Workers & Pages page. You need the full address in Parts D and F.

### C3. API token

- [ ] Profile (My Profile), API Tokens, Create Token. Choose the template for Workers: "Edit Cloudflare Workers". (Cloudflare's docs list the steps but do not name this template. If the label differs, pick the Workers template.)
- [ ] Under account resources, select your account only. Leave the zone resource as the template sets it.
- [ ] Continue to summary, then Create Token.
- [ ] Copy the token now. It is shown one time. Keep it in a password manager until Part D.

Check (optional): `curl.exe -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer <token>"` answers `"status": "active"`.

### C4. Account ID

- [ ] Workers & Pages, find "Account Details", click the copy button next to "Account ID".

Check: it is a 32-character hexadecimal string.

## D. GitHub settings

Open https://github.com/avramovioan/personal-stock-screener. Background: operator guide section 11.

### D1. Repository visibility and plan

- [ ] Settings, scroll to the bottom ("Danger Zone"), read the visibility. Note: public or private.
- [ ] If it is private on a free personal plan, GitHub does not offer "Required reviewers" on environments for private repositories (they need GitHub Pro or Team). Then either make the repository public (only if it holds nothing you want private; run `bun run check:secrets` first) or skip the reviewer rule in D4. Without the rule the Migrations job runs without waiting.

### D2. Secrets

- [ ] Settings, Secrets and variables (in the Security section of the sidebar), Actions, tab Secrets, New repository secret. Add each name, press Add secret.

| Name | Where the value comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from C3. |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID from C4. |
| `SUPABASE_ACCESS_TOKEN` | https://supabase.com/dashboard/account/tokens, generate a new token. |
| `SUPABASE_DB_PASSWORD` | The project's database password. Supabase, Project Settings, Database. Reset it there if you lost it. |

### D3. Variables

- [ ] Same page, tab Variables, New repository variable. Add each name, press Add variable.

| Name | Where the value comes from |
|---|---|
| `VITE_SUPABASE_URL` | `https://pkfptuwwgyvjxvumqika.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` in `apps/web/.env.local`. Public by design. Supabase, Project Settings, API keys shows it too. |
| `VITE_VAPID_PUBLIC_KEY` | `apps/web/.env.local`. It must equal the hosted function secret `VAPID_PUBLIC_KEY`. If the two differ, push breaks. |
| `VITE_SITE_URL` | The address from C2, with `https://` and no trailing slash. |
| `SUPABASE_PROJECT_REF` | `pkfptuwwgyvjxvumqika` |

Never put another value into a `VITE_*` variable. The build refuses secret-looking values.

`secrets list` shows only digests, so you cannot read the hosted `VAPID_PUBLIC_KEY` back. Use the value from the same file you set the hosted secret from (operator guide 4.1). If you are unsure, generate a new pair, set it on both sides and turn notifications on again on every device.

### D4. The production environment

- [ ] Settings, Environments, New environment, name it exactly `production`, Configure environment.
- [ ] Select Required reviewers, add yourself.
- [ ] Leave "Prevent self-review" unticked. You push the code yourself, so you must be able to approve it.
- [ ] Save protection rules.

Check: the Variables tab lists five names, the Secrets tab lists four, Environments shows `production` with a reviewer.

## E. Push the code and watch the deploys

### E1. Fast-forward master

- [ ] Check that `master` is an ancestor of `build/initial`.

```powershell
git merge-base --is-ancestor master build/initial; if ($LASTEXITCODE -eq 0) { "fast-forward is safe" } else { "STOP: master has commits that build/initial lacks" }
```

- [ ] Move `master` forward without switching branches. Your uncommitted files stay untouched.

```powershell
git branch -f master build/initial
git log --oneline -1 master
git log --oneline -1 build/initial
```

Check: both lines show the same hash.

### E2. Push

- [ ] Push both branches. Pushing `master` starts Deploy web and Deploy Supabase.

```powershell
git push origin master build/initial
```

### E3. Watch Actions

- [ ] GitHub, Actions. Four workflows exist: CI, Deploy web, Deploy Supabase, Keep-alive.
- [ ] Deploy web goes green. It runs the env guard, the build, the bundle secret scan and the Cloudflare deploy. If it did not start, open it, press "Run workflow", choose the `master` branch, and press the green Run workflow button.
- [ ] Deploy Supabase shows Migrations waiting. Open the run, press "Review deployments", tick `production`, press "Approve and deploy". This is safe, because Part A applied everything, so nothing is pending. Then the Edge Functions job runs and redeploys all functions. That is fine.
- [ ] CI goes green.
- [ ] Keep-alive does nothing yet (it stays off until Part I).

If Deploy web fails at "Guard production build variables", the message names the variable. Fix it in D3 and re-run (open the run, "Re-run all jobs").

### E4. Open the site

- [ ] Open `https://stock-screener.<your-subdomain>.workers.dev`.

Check: the site loads. Sign-in only works from the site after Part F.

### E5. Fallback: deploy from your computer

Use only if GitHub Actions gives trouble.

```powershell
bunx wrangler@4.151.0 login
$env:VITE_SUPABASE_URL = "https://pkfptuwwgyvjxvumqika.supabase.co"
$env:VITE_SUPABASE_ANON_KEY = "<anon key>"
$env:VITE_SITE_URL = "https://stock-screener.<your-subdomain>.workers.dev"
$env:VITE_VAPID_PUBLIC_KEY = "<public vapid key>"
bun run build
cd apps/web
bunx wrangler@4.151.0 deploy
cd ../..
```

Note: `bun run build` reads the Supabase URL from the environment or from `apps/web/.env*` (`.env`, `.env.local`, `.env.production`, `.env.production.local`), the same way Vite does. In a Cloudflare build set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SITE_URL` and `VITE_VAPID_PUBLIC_KEY` as build variables. Never hard-code the host in `apps/web/public/_headers`; it keeps the `__SUPABASE_ORIGIN__` placeholders and the build fills them in.

## F. Point the backend at the site

### F1. Function secrets

Until now `SITE_URL` is the local address. The functions use it as the allowed CORS origin.

- [ ] Run it (fill in your subdomain).

```powershell
bunx supabase secrets set SITE_URL=https://stock-screener.<your-subdomain>.workers.dev EXTRA_ALLOWED_ORIGINS=http://localhost:5173 --project-ref pkfptuwwgyvjxvumqika
```

Check: `bunx supabase secrets list --project-ref pkfptuwwgyvjxvumqika` shows both names. If the browser still shows a CORS error later, run the functions deploy of A2 once more.

### F2. Auth URL Configuration

- [ ] Supabase Dashboard, Authentication, URL Configuration.
- [ ] Set Site URL to `https://stock-screener.<your-subdomain>.workers.dev`.
- [ ] In the Redirect URLs list, remove the old entries `/auth/callback` and `/auth/update-password`. The web app never sends a redirect address any more (nothing under `apps/web/src` uses `redirectTo` or `emailRedirectTo`), and the old auth pages are gone.
- [ ] Save.

Check: reload. The Site URL shows the new address and the list holds no old entries. Background: operator guide 3.2.

## G. First sign-in on the new site

- [ ] Open the site, press Sign in. The page asks for your e-mail only. Type the address you invited in B2.
- [ ] The page asks for a new password and a confirmation ("Create your password"). Use 12 to 72 characters. Save it in a password manager.
- [ ] You are signed in. The header shows Profile.

Check: Profile opens with its sections. The flag `reset_password` on your row clears itself.

If the page says "Not possible yet", the e-mail is not on the list or has a typo. Fix the row in `invited_emails`.

### G1. IBKR link, only if not already linked

- [ ] Profile, Broker. If it shows Linked, skip this step. Your earlier link stays on the account.
- [ ] If it says "No broker is linked", follow the checklist on that page. It lists every Flex section and field (Format XML, Period Last 365 Calendar Days, Date Format yyyyMMdd, no IP restriction). Details: operator guide 5.2.

Check: the page shows Verifying, then Linked, or names the missing section or field.

## H. Notifications on each device

How it works (operator guide 4.0):

- Anyone can turn notifications on from the bell in the header. No account is needed. Each phone or browser registers by itself.
- Every device gets "New companies on the list": one digest after each scan, only when something is new.
- When it arrives: once a day, usually between 10:00 and 11:00 your time. The window is 10:00 to 11:00 Sofia time shown in the device's time zone. The daily check starts at 10:00 Sofia and the digest goes out when it finishes, at the latest by the 13:00 Sofia cut-off. A digest is sent only when something is new, so some days bring nothing.
- The test button is for tonight. It sends at once and does not wait for the daily window.
- "Alerts about my holdings" is a second step for signed-in devices. You switch it on in Profile, Notifications, not in the bell.
- Subscriptions made on localhost do not carry over. Turn them on again here, on every device.
- Subscriptions are tied to the address. If you add a custom domain later (Part M), turn them on again.
- If a device never subscribes, compare `VITE_VAPID_PUBLIC_KEY` with `VAPID_PUBLIC_KEY` (D3).

### H1. iPhone and iPad

Needs iOS or iPadOS 16.4 or newer. Safari tabs cannot receive push. The app must run from the Home Screen icon.

- [ ] Open the site in Safari (not in another app's built-in browser).
- [ ] Tap the Share button (on some iOS versions open the Page Menu or "More" first). Scroll and tap "Add to Home Screen". Leave "Open as Web App" on and tap Add.
- [ ] Close Safari. Open "Stock Screener" from the new Home Screen icon.
- [ ] Tap the bell in the header. The sheet is called "Notifications on this phone".
- [ ] Switch on "New companies on the list". iOS asks for permission only after this tap. Tap Allow.
- [ ] Press "Send a test notification". It arrives within seconds.

If the sheet only shows "iPhone: open this site in Safari, tap Share, then Add to Home Screen...", you are in a Safari tab. Do the install steps.
Repeat on the iPad, as a separate device.

### H2. Android

Chrome is the verified path.

- [ ] Open the site in Chrome.
- [ ] Optional but good: tap the three-dot More menu, then "Install and create shortcut", then Install. Open the site from the new icon. (Chrome's help uses these labels today. Newer versions may say "Install app" or "Add to Home screen". Choose the entry that installs.)
- [ ] Tap the bell, switch on "New companies on the list", tap Allow on the permission prompt.
- [ ] Press "Send a test notification".

Samsung Internet and Firefox for Android: the bell sheet says "Notifications are not available in this browser" when the browser cannot do it. I could not confirm their current push support in official docs, so use Chrome tonight.

### H3. Desktop browsers

- [ ] Chrome or Edge: open the site, click the bell, switch on "New companies on the list", choose Allow. Press "Send a test notification".
- [ ] Firefox: same steps. Firefox shows its own permission prompt near the address bar.
- [ ] Safari on a Mac: macOS Sonoma 14 or newer can turn a site into a web app (Apple calls them Safari web apps). Apple says to answer the notification request in the web app, not in Safari. The web app then appears by name in System Settings, Notifications. Plain Safari tabs are not verified here, so prefer Chrome, Edge or Firefox on a Mac.

The Edge and Firefox menu labels were not verified against their help pages. The bell sheet is the same everywhere.

### H4. Holdings alerts on a signed-in device

A signed-out device cannot get holdings alerts. The device must already have notifications turned on from the bell (H1 to H3).

- [ ] On that device, sign in.
- [ ] Open Profile, then Notifications.
- [ ] Switch on "Alerts about my holdings on this device".

Check: the switch stays on after a reload. A signed-in device gets its user's own digest, so it never receives both digests for one run.
A device registered before you signed in stays anonymous until you sign in on it and open the site again.

### H5. Turn off

- [ ] Open the bell and press "Turn off on this phone". Check: the switch and the test button are gone.
- [ ] To stop holdings alerts only, switch off "Alerts about my holdings on this device" in Profile, Notifications.

### H6. If something does not work

| Symptom | Cause | Fix |
|---|---|---|
| The sheet says to set Notifications to Allow | The permission is blocked for this site | Chrome desktop: click the "View site information" icon next to the address and turn on Notifications. Chrome on Android: open the site, tap "Page info" left of the address bar, Permissions, Notifications, Allow. Then reload. iPhone: Settings, Notifications, find the Home Screen app and allow notifications (exact wording not verified). |
| The sheet shows only the Safari steps on an iPhone | You opened it in a Safari tab | Open it from the Home Screen icon. |
| iPhone: no permission prompt | iOS is older than 16.4, or the icon was added with "Open as Web App" off | Update iOS. Delete the icon and add it again with Open as Web App on. |
| The test arrives on desktop but not on the phone | Focus or Do Not Disturb is on, or the app's notifications are off in system settings | Turn Focus or Do Not Disturb off. Check the app's entry in the phone's notification settings (menu names vary, not verified). |
| Android: notifications arrive late or never | Battery optimisation puts Chrome to sleep | In the phone's battery settings set Chrome (or the installed app) to unrestricted. Names vary by maker. |
| "Too many devices" | The account has reached its device limit | Turn off notifications on a device you no longer use, then try again. |
| The test gives an error | The keys differ, or the subscription was revoked | Turn off, then on again. Compare the keys (D3). Operator guide 4.6. |

## Hb. Optional: Telegram group

Skip this part if you do not want a Telegram group message. Do it after Part H. Nothing else depends on it.

The group gets one message per scan run, only when something is new. It follows the same rules as the phone digest. Holdings alerts never go to Telegram. Full details and the error table: operator guide 4.8.

### Hb1. Create the bot

- [ ] In Telegram, open `@BotFather` and send `/newbot`.
- [ ] Send a display name, for example `Stock Screener`.
- [ ] Send a username. It must end in `bot`, for example `my_stock_screener_bot`.
- [ ] Copy the token from BotFather's answer. Treat it like a password. Never paste it into a chat or a ticket.

### Hb2. Add the bot to the group

- [ ] Open the group, tap the group name, tap "Add members", search for the bot's username, add it.
- [ ] Send any message in the group, for example `hello`.

### Hb3. Find the chat id

- [ ] Open this address in a browser, with your own token in place of `<token>`: `https://api.telegram.org/bot<token>/getUpdates`
- [ ] Find `"chat":{"id":-100...`. Copy the number with its minus sign.

Check: you have a negative number, and a supergroup number starts with `-100`.
If the answer is `"result":[]`, send another message in the group and reload the page.
If it stays empty, make the bot an admin for a minute, or send `/setprivacy` to `@BotFather`, pick the bot and choose "Disable". Telegram applies a privacy change to a group only after the bot is removed and added again. Then send a new message and reload.
`getUpdates` fails while a webhook is set on the bot. This project sets none, so a new bot is fine.
Telegram keeps unread updates for 24 hours only.

### Hb4. Push the migration and redeploy two functions

Database first, then the functions. If you have not done A1 and A2 yet, they already cover this: the dry run in A1 then lists `20261015009800` as well, and A2 deploys every function.

- [ ] Preview.

```powershell
bunx supabase db push --dry-run
```

It must list `20261015009800_telegram.sql` (and nothing you do not expect).

- [ ] Apply it.

```powershell
bunx supabase db push
```

- [ ] Deploy the two functions (Docker Desktop running).

```powershell
bunx supabase functions deploy notify-dispatch --project-ref pkfptuwwgyvjxvumqika
bunx supabase functions deploy scan-control --project-ref pkfptuwwgyvjxvumqika
```

`worker-tick` needs no redeploy for Telegram.
Check: a second `bunx supabase db push` says the remote database is up to date.

### Hb5. Set the two secrets

- [ ] Create `supabase/functions/.env.telegram` (git-ignored) with two lines. Use your own values:

```text
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_CHAT_ID=<the id with the minus sign>
```

- [ ] Set them, then delete the file.

```powershell
bunx supabase secrets set --env-file supabase/functions/.env.telegram --project-ref pkfptuwwgyvjxvumqika
Remove-Item supabase/functions/.env.telegram
bunx supabase secrets list --project-ref pkfptuwwgyvjxvumqika
```

Check: the list shows `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. It never shows values.

### Hb6. Send the test message

- [ ] Run the call. It asks for the cron secret (hidden input) unless `$env:SCREENER_CRON_SECRET` is set. Never paste it anywhere else.

Run `scripts/telegram-test.ps1`. It calls `scan-control` with `telegram_test` and prints the answer. See `scripts/README.md` for all test scripts and the one-time session setup.

Check: the answer says `ok: True`, `telegram_status: 200`, `description: sent`, and the group shows "Test message from the stock screener."
The call always answers HTTP 200. Read `ok` and `description` for Telegram's own answer.

#### Send the latest digest now

Use it when the group got nothing. It takes the latest public digest that is ready and younger than 24 hours, queues its Telegram message
(or tries a failed or skipped one again) and does nothing when it was already sent. The group gets it within a minute.

Run `scripts/telegram-send-latest.ps1`. It calls `scan-control` with `telegram_send_latest` and prints the answer. See `scripts/README.md`.

Check: `ok: True` and `queued: True` with `digest_id`, `scan_date` and `note: sends within a minute`. Other answers: `queued: False` with
`reason` `already_sent`, `no_ready_digest` (no ready digest in the last 24 hours) or `not_configured` (a secret is missing).
Needs `bunx supabase db push` (migration 20261015009900) and a redeploy of `scan-control`.

### Hb7. What a real message looks like, and when it comes

```text
New on the screener · 21 Oct
• MSFT Microsoft Corporation · #4 · at its −3 line
• SAP SAP SE · #12 · at its −3 line

Open the screener
```

- It comes after the daily scan, usually between 10:00 and 11:00 Sofia time. It is sent only when something is new, so some days bring nothing.
- Each company is one line: ticker, name, rank and line. At most 20 lines, then `…and N more`. No prices.
- A failed send retries after 1 minute, 5 minutes, 30 minutes and 2 hours. It is given up after 5 attempts or 24 hours.

### Hb8. Turn off

- [ ] Unset either secret. Nothing else changes and nothing fails.

```powershell
bunx supabase secrets unset TELEGRAM_BOT_TOKEN --project-ref pkfptuwwgyvjxvumqika
```

Messages created while it was off and younger than 24 hours are sent when you turn it on again. Older ones are dropped.

## I. Keep-alive job

A free Supabase project pauses after a week without activity. The daily job prevents that (operator guide section 12). It runs daily at 06:17 UTC and only when `KEEPALIVE_ENABLED` is `true`.

- [ ] Supabase Dashboard, Authentication, Users, Add user. Use a dedicated e-mail and a strong password, and tick auto-confirm. (The label "Add user" comes from the operator guide and was not re-verified in the current docs.)
- [ ] GitHub, Settings, Secrets and variables, Actions, tab Secrets: add `KEEPALIVE_EMAIL` and `KEEPALIVE_PASSWORD` with those credentials.
- [ ] Tab Variables: add `KEEPALIVE_SUPABASE_URL` (same value as `VITE_SUPABASE_URL`) and `KEEPALIVE_ANON_KEY` (same value as `VITE_SUPABASE_ANON_KEY`).
- [ ] Add the variable `KEEPALIVE_ENABLED` with the value `true`. `KEEPALIVE_MAX_AGE_HOURS` is optional, leave it unset.
- [ ] Actions, Keep-alive, Run workflow, branch `master`, Run workflow.

Check: the run is green. The keep-alive user is not on the invite list. That is fine, it never signs in on the site.

## J. Final checks

- [ ] The site loads at the workers.dev address.
- [ ] Deep link refresh: open `https://stock-screener.<your-subdomain>.workers.dev/portfolio` signed out, sign in, and you land on `/portfolio`. Press F5. The app still shows.
- [ ] Sign out and sign in again with e-mail and password.
- [ ] Overview shows companies (or the honest empty state).
- [ ] On a company card, press "Scan with AI". It answers with a report or a clear reason such as a cooldown. It does not show an error page.
- [ ] Open the browser console (F12). There are no CORS errors and no Content-Security-Policy errors.
- [ ] Security headers. Look for `content-security-policy` in the output.

```powershell
curl.exe -sI https://stock-screener.<your-subdomain>.workers.dev
```

- [ ] A test push arrived on every device from Part H.
- [ ] Tomorrow morning: a real digest arrives between 10:00 and 11:00 your time on each device, but only if something new reached the list. No digest on a quiet day is normal.
- [ ] `bunx supabase secrets list --project-ref pkfptuwwgyvjxvumqika` shows no e-mail names and none of the local-only names (`ALLOW_FIXTURE_PROVIDERS`, `FLEX_FIXTURE_MODE`, `PUSH_ENDPOINT_EXTRA_HOSTS`, `JWT_ISSUER`).
- [ ] Supabase, Authentication, Users shows only accounts you know.

## K. Inviting friends

- [ ] Add the row. Supabase Dashboard, Table Editor, `invited_emails`, Insert row. Fill `email`. Leave `reset_password` unticked. `note` is for you.
- [ ] Send the link `https://stock-screener.<your-subdomain>.workers.dev`. Tell them: press Sign in, type your e-mail, create a password of 12 to 72 characters.
- [ ] Add a friend only when they are ready to sign in. An invite nobody has used yet can be claimed by whoever types that e-mail first.

What a friend sees: the same site as everyone, plus Profile (password, Broker, Notifications), Portfolio, Analytics and holdings alerts. Everyone, signed in or not, sees Trade on IBKR on the cards and can turn on notifications from the bell.
For Portfolio they open Profile, Broker and link their own IBKR Flex query. The page lists the steps.

Forgotten password: open their row in `invited_emails` and tick `reset_password`. Their next sign-in asks for a new password. Tick it when they are ready.

Remove someone, both steps:

1. [ ] Delete the row in `invited_emails`.
2. [ ] Authentication, Users, open the user, Delete user. This also deletes their broker link, statements, positions and notification settings.

Honest privacy note: the first sign-in step shows whether an e-mail is on the list. As the owner you can read your friends' data in the database dashboard. Broker tokens are stored encrypted, but you hold the keys. The app sends no e-mails. Tell friends this before you invite them.

## L. Afterwards

- A push to `master` that changes `apps/web/**`, `supabase/functions/_shared/core/**` or `bun.lock` redeploys the web app by itself.
- A push that changes `supabase/**` starts Deploy Supabase. It waits for your approval on `production` before it changes the database.
- To deploy by hand: Actions, pick the workflow, Run workflow.
- Function secrets are never set by CI. Set them with `bunx supabase secrets set`.
- Local development after the cut-over: `apps/web/.env.local` keeps pointing at your local stack. The hosted functions also allow `http://localhost:5173` through `EXTRA_ALLOWED_ORIGINS`. To sign in locally, insert your e-mail in the local `invited_emails` (operator guide 3.4). Notifications turned on at localhost do not work on the live site, and the other way round.
- Rotations, backups and the yearly reminder: operator guide 13.

## M. Optional: a custom domain

Only when the domain is already on your Cloudflare account.

- [ ] Edit `apps/web/wrangler.jsonc`: uncomment the `routes` line and put your host in it, for example `screener.<your-domain>`. Commit and push to `master`. (Dashboard alternative: Workers & Pages, the Worker `stock-screener`, Settings, Domains & Routes, Add, Custom Domain, enter the host, Add Custom Domain. Prefer the file, so the config and the portal agree.)
- [ ] Change the GitHub variable `VITE_SITE_URL` to `https://screener.<your-domain>`. Run Deploy web again.
- [ ] Set the function secret `SITE_URL` to the same address (command in F1).
- [ ] Change the Site URL in Supabase, Authentication, URL Configuration (F2).
- [ ] Turn notifications on again on every device (Part H).
- [ ] Enable HSTS: Cloudflare Dashboard, SSL/TLS, Edge Certificates, HSTS. Details and the check command: operator guide section 6.
- [ ] Optional: set `"workers_dev": false` in `apps/web/wrangler.jsonc` to close the old address.

## N. Optional leftovers from 2026-10-19

Skip this part if the cards look right.

Both calls need the shared cron secret. Type it at the prompt. Never paste it anywhere else.

```powershell
$secret = Read-Host "CRON_SHARED_SECRET"
```

### N1. Force research for a deferred card

Find the card's `security_id` in the Supabase SQL Editor (table `securities`).

Run `scripts/research-now.ps1 -SecurityId <security uuid> -ForceReport`. It asks for the cron secret (hidden input), confirms before it spends AI quota and queues the report.

`force` re-runs a report that failed or was deferred. Operator guide 9.4 and 9.5 show how to read the result.

### N2. Exclude ACALG.PA

Its Yahoo listing returns no price bars, so every daily scan counts it as a failure. An `exclude` override removes it.

```powershell
'{"action":"override","kind":"exclude","yahoo_symbol":"ACALG.PA","reason":"no price bars"}' | curl.exe -X POST "https://pkfptuwwgyvjxvumqika.supabase.co/functions/v1/scan-control" -H "x-cron-secret: $secret" -H "content-type: application/json" --data-binary "@-"
```

The change takes effect at the next scan (operator guide 8.1).

## Appendix: troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `db push --dry-run` lists extra or older migrations | The remote history differs | Read the list. Use `--include-all` only when it is right (operator guide 2.2). |
| `functions deploy` fails with a Docker error | Docker Desktop is not running | Start it, wait until it is ready, run again. |
| Deploy web fails at "Guard production build variables" | A `VITE_*` variable is missing, local, not https, or looks like a secret | The log names the variable. Fix it in D3 and re-run. |
| Deploy web fails at the Cloudflare step | Wrong token or Account ID | Check `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (C3, C4). |
| Deploy Supabase waits forever | The Migrations job needs your approval | Open the run, Review deployments, tick `production`, Approve and deploy. |
| No "Review deployments" button | The environment has no reviewer, or the repository is private on a free plan | D1 and D4. Without a reviewer the job runs by itself. |
| "Run workflow" button is missing | The workflow file is not on the default branch yet | Push `master` first (Part E). |
| Browser console shows CORS errors | `SITE_URL` is wrong or has a trailing slash | Redo F1, then deploy the functions again (A2). |
| Sign-in says "Not possible yet" | The e-mail is not in `invited_emails` | Add or fix the row (B2, K). |
| Sign-in asks for a password you do not have | Your account has no password yet | Tick `reset_password` on your row, sign in, create one. |
| Strangers can create accounts | Public sign-up is on | B1. Then check Authentication, Users. |
| Blank page after a deep link refresh | Old cache or a failed deploy | Hard refresh (Ctrl+F5). Check that Deploy web is green. |
| No pushes arrive anywhere | Key mismatch, or no fresh scan yet | Compare the two VAPID keys, then send a test from the bell. Digests go out only when something is new. |
| Bell test says "The server's push keys are not set up correctly." | The hosted `VAPID_*` secrets are missing, not JSON, or the public key does not pair with the private key | Run the `health` curl in "Re-set the push keys" and read `push.problem`. Then re-set the keys the safe way. |
| Bell test says "This phone's subscription does not match the server key." | The push service answered 403: the phone subscribed with an older key | Turn notifications off and on again on that phone. The app now replaces such a subscription by itself when you turn it on. |
| Bell test says "The push service could not be reached." | The function could not connect to the phone's push service | Try again. If it repeats, check the Supabase function logs for `push_test_failed`. |
| Bell test says "This phone is not registered any more." | The push service answered 404 or 410: the subscription is gone | Turn a switch on to register the phone again. |
| Pushes stopped after a domain change | Subscriptions are tied to the address | Turn notifications on again (Part H). |
| Telegram test says `not_configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID` | A secret is missing or blank, or `scan-control` was not redeployed | Hb5, then deploy `scan-control` (Hb4). |
| Telegram test says `Unauthorized` | The bot token is wrong or was revoked | Copy the token again from `@BotFather` (`/mybots`, the bot, API Token) and set it again (Hb5). |
| Telegram test says `Bad Request: chat not found` | The chat id is wrong (missing minus sign) or the bot is not in the group | Redo Hb2 and Hb3, then set the id again. |
| Telegram test says `Forbidden: bot was kicked from the group chat` | The bot was removed from the group | Add it again (Hb2). |
| Telegram test says `Too Many Requests: retry after N` | Telegram asks for a pause | Wait N seconds, try again. |
| Telegram test says `network_error` | The function could not reach Telegram | Try again later. |
| `getUpdates` shows `"result":[]` | The bot sees no group messages (privacy mode), or the messages are older than 24 hours | Send a new message. Make the bot admin for a minute, or `/setprivacy` Disable and re-add the bot (Hb3). |
| Keep-alive run is skipped | `KEEPALIVE_ENABLED` is not `true` | Part I. |
| Keep-alive run is red | Wrong credentials, a stale scan, or `health` is not ok | Read the log. Operator guide 12. |
| Supabase project is paused | No activity for a week | Dashboard, the project, Resume. Keep-alive prevents this. |

### Re-set the push keys

Use this when `health` reports a `push.problem`, or after any key change. Set all three secrets from one file. Never type the private key JSON on the command line: PowerShell strips its quotes.

- [ ] Generate new keys into a git-ignored file (use your own address):

```powershell
bun run gen:vapid -- mailto:<you> --out supabase/functions/.env.vapid
```

- [ ] Set all three secrets from that file:

```powershell
bunx supabase secrets set --env-file supabase/functions/.env.vapid --project-ref pkfptuwwgyvjxvumqika
```

- [ ] Copy the public key (`VAPID_PUBLIC_KEY` in that file) into the GitHub repository variable `VITE_VAPID_PUBLIC_KEY`, then delete `supabase/functions/.env.vapid`.
- [ ] Redeploy the web app (run Deploy web) so the new public key is in the bundle.
- [ ] Check the server side. The `push` field must read `configured: true` and `problem: null`:

Run `scripts/health.ps1`. It prints the health answer and highlights `push.configured` (no secret needed).

Problem codes: `public_missing`, `private_missing`, `subject_missing`, `subject_invalid` (must start with `mailto:` or `https://`), `private_not_json` (quotes lost), `private_not_jwk`, `private_invalid`, `key_mismatch` (public and private keys do not pair).

- [ ] Every device: bell, "Turn off on this phone", then turn notifications on again. Old subscriptions belong to the old key.
