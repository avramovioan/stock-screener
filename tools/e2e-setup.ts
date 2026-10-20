// biome-ignore-all lint/suspicious/noExplicitAny: PostgREST and function responses are untyped JSON
// Local end-to-end environment (spec 17.5, P7 Task 4). Idempotent. `--ensure` skips the reset, the seed and the scan when the data is
// already there (it still refreshes the market-data cache rows, which expire).
//
// The Edge Functions are the ones the local stack serves itself (`supabase start`); they read supabase/functions/.env. This script checks
// that file (fixture flags, Flex key, rate-limit salt, VAPID keys, a push host for the fake push endpoint) and does not edit it.
//
// What a full run does, in order (the reset is announced in the log; the suite owns the local database):
//   1. supabase start (when the stack is down), supabase db reset
//   2. two users through the admin API (owner and other, password E2E_PASSWORD), both listed in public.invited_emails
//   3. AAPL and SHEL.L securities, link the owner's broker connection, post the fixture Flex statement to broker-sync (ingest_fixture)
//      BEFORE the scan, so the scan's portfolio_scan stage has a holder
//   4. a fixture-mode scan (universe, research, EUR catalogue, digests; tools/run-local-scan.ts start --mode fixture, then tick)
//   5. assertions on portfolio_scan: held securities carry a valuation tag; premium episodes agree with the holding's close
//   6. one research report for the first card when the scan produced none; synthetic chart and quote cache rows (no Yahoo access)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalStackUrl,
  E2E_PASSWORD,
  invitedEmailRow,
  jwtIssuerProblem,
  missingFunctionEnv,
  OTHER_EMAIL,
  OWNER_EMAIL,
  parseEnvFile,
} from "./lib/e2e-env.ts";
import { pauseLocalCron } from "./lib/local-cron.ts";
import { callFunction, resolveStack, rest, sleep } from "./lib/local-stack.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const ensure = process.argv.includes("--ensure");
const skipReset = process.argv.includes("--skip-reset"); // development: keep the current database, redo the seed and the scan
const envFile = join(root, "supabase", "functions", ".env");

function sh(command: string, args: string[]): void {
  console.log(`e2e-setup: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}
const stackIsUp = () =>
  spawnSync("bunx", ["supabase", "status", "-o", "json"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    stdio: "pipe",
  }).status === 0;

// 0. the functions env file
if (!existsSync(envFile))
  throw new Error(
    "supabase/functions/.env is missing: copy .env.example and see docs/operator-guide.md",
  );
const functionsEnv = parseEnvFile(readFileSync(envFile, "utf8"));
const problems = missingFunctionEnv(functionsEnv);
if (problems.length > 0)
  throw new Error(
    `supabase/functions/.env cannot run the e2e suite:\n  ${problems.join("\n  ")}\n(restart the stack, \`bunx supabase stop\` then \`bunx supabase start\`, after editing it)`,
  );
const issuerProblem = jwtIssuerProblem(functionsEnv);
if (issuerProblem !== undefined) throw new Error(issuerProblem);
process.env.CRON_SHARED_SECRET = functionsEnv.CRON_SHARED_SECRET;

if (!stackIsUp()) sh("bunx", ["supabase", "start"]);
const stack = resolveStack();
// the suite deletes and recreates users and writes with the service key: only ever against the local stack
assertLocalStackUrl(stack.url);
const admin = {
  apikey: stack.serviceKey,
  authorization: `Bearer ${stack.serviceKey}`,
  "content-type": "application/json",
};

async function send(
  path: string,
  method: string,
  body: unknown,
  prefer = "return=representation",
): Promise<any> {
  const res = await fetch(`${stack.url}/rest/v1/${path}`, {
    method,
    headers: { ...admin, prefer },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json().catch(() => null);
}

async function waitForFunctions(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${stack.url}/functions/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error("the Edge Functions are not served (bunx supabase start, then rerun)");
}

async function userByEmail(email: string): Promise<string | null> {
  // page through the list: the auth spec leaves a random user behind on every run
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${stack.url}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: admin,
    });
    const list = (await res.json()) as { users?: Array<{ id: string; email?: string }> };
    const users = list.users ?? [];
    const found = users.find((u) => u.email === email);
    if (found !== undefined) return found.id;
    if (users.length < 200) return null;
  }
  return null;
}

async function isSeeded(): Promise<boolean> {
  try {
    const runs = await rest(stack, "scan_runs?select=status&order=scan_date_local.desc&limit=1");
    if (runs[0]?.status !== "complete" && runs[0]?.status !== "partial") return false;
    const owner = await userByEmail(OWNER_EMAIL);
    if (owner === null || (await userByEmail(OTHER_EMAIL)) === null) return false;
    const held = await rest(
      stack,
      `broker_positions?select=valuation_tag&user_id=eq.${owner}&valuation_tag=not.is.null&limit=1`,
    );
    const reports = await rest(stack, "research_reports?select=id&status=eq.complete&limit=1");
    const cards = await rest(
      stack,
      "todays_discounts?select=security_id&withheld=eq.false&limit=1",
    );
    return held.length > 0 && reports.length > 0 && cards.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------- synthetic market data
const WEEKDAY_BARS = 2600;
const round = (n: number) => Math.round(n * 100) / 100;

function syntheticChart(symbol: string, seed: number, base: number) {
  // 2600 weekdays ending before today; a seeded random walk with positive drift
  const days: number[] = [];
  const d = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  while (days.length < WEEKDAY_BARS) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      days.unshift(Math.floor(d.getTime() / 86_400_000));
  }
  let state = seed;
  const rnd = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  let price = base * 0.3;
  const drift = (base / price) ** (1 / WEEKDAY_BARS);
  for (let i = 0; i < WEEKDAY_BARS; i++) {
    const o = price;
    price = Math.max(1, price * drift * (1 + (rnd() - 0.5) * 0.03));
    open.push(round(o));
    close.push(round(price));
    high.push(round(Math.max(o, price) * (1 + rnd() * 0.01)));
    low.push(round(Math.min(o, price) * (1 - rnd() * 0.01)));
    volume.push(Math.floor(1_000_000 + rnd() * 500_000));
  }
  return {
    symbol,
    currency: "USD",
    exchange: "NMS",
    exchangeTimezoneName: "America/New_York",
    longName: `${symbol} (e2e series)`,
    bar_dates: days,
    open,
    high,
    low,
    close,
    volume,
    regularMarketTime: Date.now() - 60_000,
    marketState: "CLOSED",
  };
}

const quotePayload = (
  symbol: string,
  price: number,
  currency: string,
  exchange: string,
  state: string,
) => ({
  symbol,
  currency,
  exchange,
  fullExchangeName: exchange,
  longName: `${symbol} (e2e)`,
  regularMarketPrice: price,
  regularMarketTime: Date.now() - 60_000,
  regularMarketChangePercent: 1,
  marketState: state,
  fetchedAt: new Date().toISOString(),
  stale: false,
});

/** Chart and quote cache rows for the card symbols and AAPL, plus FX and the Shell quote the Portfolio values with. */
async function refreshMarketCache(): Promise<string[]> {
  const feed = await fetch(`${stack.url}/rest/v1/rpc/todays_discounts_feed`, {
    method: "POST",
    headers: {
      apikey: stack.anonKey,
      authorization: `Bearer ${stack.anonKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_mode: "worldwide" }),
  });
  const cards = feed.ok
    ? ((await feed.json()) as Array<{ yahoo_symbol: string }>).map((r) => r.yahoo_symbol)
    : [];
  const symbols = [...new Set(["AAPL", ...cards])];
  const expires = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const rows: any[] = [];
  symbols.forEach((symbol, i) => {
    const chart = syntheticChart(symbol, 7 + i, 120 + 15 * i);
    rows.push({
      key: `chart:${symbol}:v1`,
      payload: chart,
      provider: "yahoo",
      expires_at: expires,
    });
    rows.push({
      key: `quote:${symbol}`,
      payload: quotePayload(
        symbol,
        chart.close[chart.close.length - 1] ?? 100,
        "USD",
        "NMS",
        "CLOSED",
      ),
      provider: "yahoo",
      expires_at: expires,
    });
  });
  const extra = (symbol: string, price: number, currency: string) => ({
    key: `quote:${symbol}`,
    payload: quotePayload(symbol, price, currency, "X", "REGULAR"),
    provider: "yahoo",
    expires_at: expires,
  });
  rows.push(
    extra("SHEL.L", 2735, "GBp"),
    extra("USDEUR=X", 0.93, "EUR"),
    extra("GBPEUR=X", 1.16, "EUR"),
  );
  await send(
    "quote_cache?on_conflict=key",
    "POST",
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return symbols;
}

// ---------------------------------------------------------------------------------------------------------- main
await waitForFunctions();
if (ensure && (await isSeeded())) {
  const symbols = await refreshMarketCache();
  console.log(JSON.stringify({ ok: true, ensured: true, stack: stack.url, chartSymbols: symbols }));
  process.exit(0);
}

if (!skipReset) {
  console.log("e2e-setup: running `supabase db reset` (the e2e suite owns the local database)");
  sh("bunx", ["supabase", "db", "reset"]);
  await waitForFunctions();
}

// The real cron jobs would start scans that compete with the fixture scan; they come back when the setup ends.
const resumeCron = pauseLocalCron(stack.url);
try {
  async function recreateUser(email: string): Promise<string> {
    const old = await userByEmail(email);
    if (old !== null)
      await fetch(`${stack.url}/auth/v1/admin/users/${old}`, { method: "DELETE", headers: admin });
    const created = await fetch(`${stack.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ email, password: E2E_PASSWORD, email_confirm: true }),
    });
    if (!created.ok) throw new Error(`creating ${email} failed: HTTP ${created.status}`);
    return ((await created.json()) as { id: string }).id;
  }
  const ownerId = await recreateUser(OWNER_EMAIL);
  await recreateUser(OTHER_EMAIL);
  // invite-only sign-in: every e2e user is on the invite list (idempotent on re-runs, --skip-reset included)
  await send(
    "invited_emails?on_conflict=email",
    "POST",
    [OWNER_EMAIL, OTHER_EMAIL].map(invitedEmailRow),
    "resolution=merge-duplicates,return=minimal",
  );

  async function companyId(name: string, normalized: string): Promise<string> {
    const found = await rest(stack, `companies?select=id&name_normalized=eq.${normalized}`);
    if (found[0] !== undefined) return found[0].id;
    return (await send("companies", "POST", { name, name_normalized: normalized }))[0]?.id ?? "";
  }
  const apple = await companyId("Apple Inc", "apple");
  const shell = await companyId("Shell plc", "shell");
  await send(
    "securities?on_conflict=yahoo_symbol",
    "POST",
    [
      {
        company_id: apple,
        yahoo_symbol: "AAPL",
        exchange_code: "NMS",
        currency: "USD",
        currency_major: "USD",
        minor_divisor: 1,
        quote_type: "EQUITY",
        isin: "US0378331005",
        is_canonical: true,
      },
      {
        company_id: shell,
        yahoo_symbol: "SHEL.L",
        exchange_code: "LSE",
        currency: "GBp",
        currency_major: "GBP",
        minor_divisor: 100,
        quote_type: "EQUITY",
        isin: "GB00BP6MXD84",
        is_canonical: true,
      },
    ],
    "resolution=merge-duplicates,return=minimal",
  );
  await send(
    "broker_connections?on_conflict=user_id",
    "POST",
    { user_id: ownerId, status: "linked", query_id: "123456", linked_at: new Date().toISOString() },
    "resolution=merge-duplicates,return=minimal",
  );
  const xml = readFileSync(
    join(
      root,
      "supabase",
      "functions",
      "_shared",
      "adapters",
      "fixtures",
      "flex",
      "activity-sample.xml",
    ),
    "utf8",
  );
  await callFunction(stack, "broker-sync", { action: "ingest_fixture", userId: ownerId, xml });

  // A fixture scan replays a simulated date, but the research steps read the real clock: lift the weekdays-only rule
  // (research.ai_weekdays_only) so the local suite works on a Saturday too. The rule itself is covered by the Deno and pgTAP suites.
  const researchSetting = (await rest(stack, "app_settings?select=value&key=eq.research"))[0]
    ?.value;
  await send(
    "app_settings?key=eq.research",
    "PATCH",
    { value: { ...researchSetting, ai_weekdays_only: false } },
    "return=minimal",
  );

  sh("bun", ["run", "tools/run-local-scan.ts", "start", "--mode", "fixture"]);
  sh("bun", ["run", "tools/run-local-scan.ts", "tick", "--max-minutes", "25"]);
  await refreshMarketCache();

  // portfolio_scan assertions (the stage ran inside the scan above, with the owner as the holder)
  const positions = await rest(
    stack,
    `broker_positions?select=symbol,valuation_tag,valuation_reason,signal_security_id&user_id=eq.${ownerId}&order=symbol`,
  );
  const tags = Object.fromEntries(positions.map((p) => [p.symbol, p.valuation_tag]));
  const episodes = await rest(
    stack,
    "signal_episodes?select=kind,status,securities(yahoo_symbol)&kind=in.(premium1,premium2)",
  );
  const results = await rest(
    stack,
    "scan_security_results?select=close,channel,status,securities!inner(yahoo_symbol)&securities.yahoo_symbol=eq.AAPL",
  );
  console.log("e2e-setup: portfolio_scan", JSON.stringify({ tags, episodes, aapl: results[0] }));
  // AAPL has a processed fixture series whose close (342.96) is above the +2 line; SHEL.L has no fixture series
  if (tags.SHEL !== "unavailable")
    throw new Error(`portfolio_scan: SHEL expected tag unavailable, got ${tags.SHEL}`);
  const aapl = results[0];
  if (aapl?.status !== "processed" || aapl.channel?.end === undefined || aapl.close === null)
    throw new Error(
      `portfolio_scan precondition: AAPL has no processed scan result with a channel: ${JSON.stringify(aapl)}`,
    );
  const end = aapl.channel.end;
  if (!(aapl.close > end.upper2))
    throw new Error(
      `portfolio_scan precondition: AAPL close ${aapl.close} is not above the +2 line ${end.upper2}`,
    );
  if (tags.AAPL !== "extra_premium")
    throw new Error(`portfolio_scan: AAPL expected tag extra_premium, got ${tags.AAPL}`);
  for (const kind of ["premium1", "premium2"]) {
    const active = episodes.filter(
      (e) => e.securities?.yahoo_symbol === "AAPL" && e.kind === kind && e.status === "active",
    );
    if (active.length !== 1)
      throw new Error(
        `portfolio_scan: expected one active ${kind} episode for AAPL, found ${active.length}`,
      );
  }

  // the data the specs hard-assert on: published cards, a company list, a complete research report
  const anonHeaders = {
    apikey: stack.anonKey,
    authorization: `Bearer ${stack.anonKey}`,
    "content-type": "application/json",
  };
  const feedRes = await fetch(`${stack.url}/rest/v1/rpc/todays_discounts_feed`, {
    method: "POST",
    headers: anonHeaders,
    body: JSON.stringify({ p_mode: "worldwide" }),
  });
  const feed = feedRes.ok ? ((await feedRes.json()) as Array<{ withheld: boolean }>) : [];
  if (!feed.some((r) => !r.withheld))
    throw new Error("the fixture scan published no visible discount card");
  const listRes = await fetch(`${stack.url}/rest/v1/rpc/company_list`, {
    method: "POST",
    headers: anonHeaders,
    body: JSON.stringify({ p_mode: "worldwide", p_limit: 5, p_after_rank: null }),
  });
  const list = listRes.ok ? ((await listRes.json()) as unknown[]) : [];
  if (list.length === 0) throw new Error("the fixture scan published no company list");

  // a research report: the scan normally produces them; otherwise queue one for the first card
  let reports = await rest(stack, "research_reports?select=id&status=eq.complete&limit=1");
  if (reports.length === 0) {
    const cards = await rest(stack, "todays_discounts?select=security_id&limit=1");
    if (cards[0] !== undefined) {
      await callFunction(stack, "scan-control", {
        action: "research_now",
        security_id: cards[0].security_id,
      });
      for (let i = 0; i < 60 && reports.length === 0; i++) {
        await sleep(3000);
        reports = await rest(stack, "research_reports?select=id&status=eq.complete&limit=1");
      }
    }
  }
  if (reports.length === 0)
    throw new Error("no completed research report after the scan and research_now");
  console.log(
    JSON.stringify({
      ok: true,
      stack: stack.url,
      owner: OWNER_EMAIL,
      other: OTHER_EMAIL,
      researchReport: reports[0]?.id ?? null,
    }),
  );
} finally {
  resumeCron();
}
