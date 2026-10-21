# Personal stock screener

A private stock screener. Every day a resumable scan computes the standard-deviation channel of the Pine script `stddevchn.pine`
(port in `supabase/functions/_shared/core/indicator.ts`) for a worldwide universe of large companies, ranks discounted and premium
securities, researches the discounted ones with a free language model that may only cite retrieved documents, and serves the result
as a PWA. Access is invite-only: the owner lists friends' e-mails in a database table, and only they can create an account.
Anyone can turn on Web Push notifications for new companies on their device, with no account. A signed-in user can link a read-only IBKR Flex report to see a portfolio and analytics,
and prepare (never place) an order through a guided hand-off to IBKR's iBot.

Any visitor can press "Scan with AI" on a listed company to start a fresh research report. Results are shared with everyone, and each company can be scanned again after a 72-hour cooldown. The `/how-it-works` page explains the method in plain words.

To make the app operational from zero, follow the **Go-live checklist** at the top of `docs/operator-guide.md`.

## Architecture in one page

```text
Browser (PWA, React, Vite, TanStack Router and Query, Lightweight Charts)
   | HTTPS, anon key + user JWT, CSP enforced
   v
Supabase (Free)                                         Cloudflare Workers Static Assets
  Postgres: RLS on every table, pg_cron, pg_net,         serves the built SPA and _headers
  Vault, pgTAP-tested policies                           (deployed by GitHub Actions)
  Edge Functions (Deno): worker-tick, scan-control, health, quotes, retention-cleanup,
    notify-dispatch, push-subscribe, account-access, broker-sync, portfolio-refresh
   |                         |                        |
   v                         v                        v
Yahoo Finance, Frankfurter   Gemini, Tavily, Jina,    Web Push services,
(market data, FX)            SEC EDGAR (research)     IBKR Flex Web Service (read-only)
```

One algorithm source: `supabase/functions/_shared/core` is pure TypeScript shared by the Edge Functions, the web app (`@core/*`) and
the tests. Time and randomness are parameters. A minute `pg_cron` tick calls `worker-tick`, which advances the scan through its stages
(FX, universe, bars, compute, publish, news, research, digest, EUR catalogue) from a job queue. Trust boundaries, data flows and the
threat model are in the specification; the P7 security review is `docs/discovery/security-review.md`.

## Prerequisites (Windows 11 or Linux)

Bun 1.3.x, Node 22.13.1 (`.node-version`), Docker Desktop, Deno 2.x (`npm i -g deno`). The Supabase CLI is a dev dependency
(`bunx supabase ...` or the `supabase:*` scripts).

## Quick start

```text
bun install
bun run dev                   # Vite dev server on http://localhost:5173
bun run supabase:start        # local Supabase stack (Docker)
bun run supabase:serve        # Edge Functions (second terminal)
bun run scan:local -- start --mode fixture   # a scan over recorded data, then: bun run scan:local -- tick
```

Copy `apps/web/.env.example` to `apps/web/.env.local`, `supabase/.env.example` to `supabase/.env` and
`supabase/functions/.env.example` to `supabase/functions/.env`; never commit real values. The values needed locally, and the known
local quirks (`JWT_ISSUER`, the `kong` URL, `supabase db reset`), are in section 0 of the operator guide. After every migration
regenerate the database types with `bun run types:gen` (the stack must be running).

## Scripts

| Script | What it does |
|---|---|
| `dev`, `build`, `format`, `lint`, `lint:fix` | Vite dev server; production build (then header rendering, bundle secret scan and header check); Biome |
| `typecheck` | `tsc` for web, core and tools, plus the core purity check |
| `test`, `test:core`, `test:tools`, `test:web` | Vitest projects (and Deno tests for `test`) |
| `functions:check`, `functions:test`, `functions:selftest` | `deno check`, `deno test` and the self-test of the checker |
| `test:db` | pgTAP suites against the local stack (includes the RLS matrix) |
| `test:integration`, `test:integration:notifications`, `test:integration:broker` | fixture-mode scan, idempotency, rank change, research, notifications, broker and hand-off scenarios (stack and functions running) |
| `test:e2e` | production build served with its real headers; Playwright specs and the CSP spec |
| `e2e:setup`, `test:e2e:local` | seed the local stack (reset, users, fixture statement, fixture scan; `-- --ensure` keeps existing data); Playwright suite against the local stack |
| `check:bundle`, `check:headers`, `check:fetch`, `check:secrets`, `check:functions-config`, `check:auth-config`, `lint:workflows` | the repository guards |
| `render:headers` | substitutes the Supabase origin into the built `_headers` |
| `audit` | dependency advisories |
| `probe:ratelimit`, `keepalive` | rate-limit probe; the keep-alive check run by `keepalive.yml` |
| `gen:vapid`, `gen:icons`, `gen:fixtures:yahoo`, `gen:fixtures:world` | generators (`gen:vapid -- mailto:you@example.com --out <file>`) |
| `spike:push` | manual Web Push device spike |
| `verify:all` | runs every suite one at a time and writes the evidence to `docs/discovery/p7-evidence/` (`-- --only a,b`, `-- --skip c`) |
| `parity` | prints the channel levels of a stored series for the TradingView comparison (`parity -- --symbol MSFT --as-of 2026-10-15`; needs `SUPABASE_URL` and `SUPABASE_ANON_KEY`) |
| `release:check` | release guard: clean `build/initial`, fast-forwardable, no forbidden tracked files, every suite passing in the evidence |
| `scan:local`, `supabase:start`, `supabase:stop`, `supabase:reset`, `supabase:serve`, `types:gen` | local stack helpers |

## Repository map

```text
apps/web/                              the PWA (src/features/*, src/components, public/_headers, e2e/)
supabase/functions/_shared/core        pure domain code (indicator, bars, eligibility, ranking, episodes, accounting, digest, research)
supabase/functions/_shared/adapters    Yahoo, FX, LLM, search, fetchers, push, Flex, logging, rate limits
supabase/functions/<name>/             one Edge Function each (handler.ts, index.ts, deno.json)
supabase/migrations, supabase/tests    SQL migrations and pgTAP suites (the RLS matrix is the access matrix)
tools/                                 CLIs and their tested logic (tools/lib)
.github/workflows/                     ci, deploy-supabase, deploy-web, keepalive
docs/superpowers/specs                 the design specification
docs/superpowers/plans                 the phase plans P0 to P7
docs/discovery                         research, verification records, security review
docs/operator-guide.md                 the runbook
```

## Documents

- Operator guide (go-live checklist, local development, runbooks, costs, decisions): `docs/operator-guide.md`
- Cloudflare go-live checklist (workers.dev site, GitHub settings, sign-ups off, invite list, push): `docs/cloudflare-go-live.md`
- Optional Telegram group for new companies (bot, chat id, secrets, test call): operator guide 4.8 and part Hb of the go-live checklist
- Specification: `docs/superpowers/specs/2026-10-15-stock-screener-design.md`
- Plans: `docs/superpowers/plans/` (P0 foundations, P1 engine and pipeline, P2 AI research, P3 notifications, P4 public UI, P5a auth,
  P5b broker and portfolio, P6 IBKR hand-off, P7 hardening and release)
- Security review: `docs/discovery/security-review.md`; verification records: `docs/discovery/p0-results.md`,
  `docs/discovery/p1-results.md`

## Decisions and disclaimers

- **Cost.** Everything runs on free tiers (Supabase, Cloudflare, Gemini, Tavily, Jina, SEC EDGAR, Frankfurter); limits and
  what happens when they are exceeded are in section 16 of the operator guide.
- **Market data.** Yahoo Finance through an unofficial library. Yahoo's terms prohibit automated collection and commercial reuse; the
  owner accepted that risk and chose zero cost. A kill switch freezes all Yahoo requests; the provider interface allows replacement.
  Prices are delayed and for information only.
- **IBKR.** Read-only through the Flex Web Service: no trading permissions, no orders, no IBKR password. Positions are as of the last
  Flex statement (T+1). "Trade on IBKR" only prepares text and a checklist; the user submits in IBKR. `IBIS2` is the owner's own
  destination practice, not an IBKR-documented exchange.
- **AI research.** Free-tier models write text from numbered retrieved documents; quotes are verified against the documents and
  nothing is ever recommended. A "Meets the checks" result is not investment advice; Red and Grey are never presented as cleared.
  The free Gemini tier may use submitted (public) content to improve Google products; its terms for a public site are an open owner question.
- **Privacy and security.** The application is not end-to-end encrypted: functions with the service role and the database
  administrator can read stored data. Row level security isolates users; the Flex token is encrypted with a key held only in function
  secrets. No secret is committed; CI scans the bundle for secrets.
- **No warranty.** This is a personal project, not a financial product; nothing here is investment, tax or legal advice.
