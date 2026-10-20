// biome-ignore-all lint/suspicious/noExplicitAny: PostgREST and function responses are untyped JSON
// Broker integration test against the LOCAL stack (P5b Task 9): `bun run test:integration:broker`.
// Needs `supabase start` (it serves the functions) with supabase/functions/.env holding FLEX_FIXTURE_MODE=1, FLEX_ENC_KEY_V1 and FLEX_USER_AGENT.
// The fixture Flex statement is posted to broker-sync's worker mode (`ingest_fixture`), so no IBKR call and no token are involved.
// Everything it creates (two users, reference securities, cache rows, broker rows) is removed again.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertLocalUrl,
  createUser,
  deleteUser,
  mintUserJwt,
  resolveStack,
} from "./lib/local-stack.ts";

const stack = resolveStack();
assertLocalUrl(stack.url);
const url = stack.url;
const anon = stack.anonKey;
const cron = stack.cronSecret;

const xml = readFileSync(
  new URL(
    "../supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml",
    import.meta.url,
  ),
  "utf8",
);
const admin = createClient(url, stack.serviceKey, { auth: { persistSession: false } });
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${detail}`}`);
  if (!ok) failures += 1;
};

async function makeUser(label: string) {
  const email = `p5b-${label}-${randomBytes(4).toString("hex")}@integration.test`;
  const user = await createUser(stack, email, `Pw-${randomBytes(12).toString("hex")}-A1`);
  // The access token is minted with the issuer a real local sign-in carries (the functions' JWT_ISSUER, supabase/functions/.env).
  // PostgREST does not check the issuer, so RLS sees the user.
  const jwt = mintUserJwt(stack, user.id, email);
  const client = createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { authorization: `Bearer ${jwt}` } },
  });
  return { id: user.id, client, jwt };
}

async function count(client: SupabaseClient, table: string, userId?: string): Promise<number> {
  let q = client.from(table).select("id", { count: "exact", head: true });
  if (userId !== undefined) q = q.eq("user_id", userId);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.code} ${error.message}`);
  return n ?? 0;
}

const post = (fn: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${url}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anon, ...headers },
    body: JSON.stringify(body),
  });

const tables = [
  "broker_positions",
  "broker_trades",
  "broker_closed_lots",
  "broker_cash_transactions",
  "broker_fx_rates",
  "broker_nav",
] as const;

const a = await makeUser("a");
const b = await makeUser("b");
const restore: Array<() => PromiseLike<unknown>> = [];
try {
  // reference data the matcher needs: the exchange mapping and two canonical securities with ISINs (the identity stage normally creates them)
  for (const [code, ibkr] of [
    ["NMS", "NASDAQ"],
    ["LSE", "LSE"],
  ] as const) {
    const prev = await admin
      .from("exchanges")
      .select("ibkr_exchange_id")
      .eq("code", code)
      .maybeSingle();
    if (prev.data === null) {
      await admin.from("exchanges").insert({
        code,
        name: code === "NMS" ? "NasdaqGS" : "London Stock Exchange",
        country: code === "NMS" ? "United States" : "United Kingdom",
        timezone: code === "NMS" ? "America/New_York" : "Europe/London",
        currencies: code === "NMS" ? ["USD"] : ["GBP", "GBp"],
        ibkr_exchange_id: ibkr,
      });
      restore.push(() => admin.from("exchanges").delete().eq("code", code));
    } else {
      await admin.from("exchanges").update({ ibkr_exchange_id: ibkr }).eq("code", code);
      const before = prev.data.ibkr_exchange_id as string | null;
      restore.push(() =>
        admin.from("exchanges").update({ ibkr_exchange_id: before }).eq("code", code),
      );
    }
  }
  const seedSecurity = async (
    symbol: string,
    company: string,
    sec: Record<string, unknown>,
  ): Promise<string | undefined> => {
    const prev = await admin
      .from("securities")
      .select("id,isin,is_canonical")
      .eq("yahoo_symbol", symbol)
      .maybeSingle();
    if (prev.data !== null) {
      await admin.from("securities").update({ isin: sec.isin }).eq("id", prev.data.id);
      restore.push(() =>
        admin
          .from("securities")
          .update({ isin: prev.data?.isin ?? null })
          .eq("id", prev.data?.id),
      );
      return prev.data.id as string;
    }
    const co = await admin
      .from("companies")
      .insert({ name: company, name_normalized: company.toLowerCase() })
      .select("id")
      .single();
    const s = await admin
      .from("securities")
      .insert({ company_id: co.data?.id, yahoo_symbol: symbol, ...sec })
      .select("id")
      .single();
    restore.push(async () => {
      await admin.from("securities").delete().eq("id", s.data?.id);
      await admin.from("companies").delete().eq("id", co.data?.id);
    });
    return s.data?.id as string | undefined;
  };
  const s1 = await seedSecurity("AAPL", "Apple Inc", {
    exchange_code: "NMS",
    currency: "USD",
    currency_major: "USD",
    quote_type: "EQUITY",
    isin: "US0378331005",
    is_canonical: true,
    role: "canonical",
  });
  const s2 = await seedSecurity("SHEL.L", "Shell plc", {
    exchange_code: "LSE",
    currency: "GBp",
    currency_major: "GBP",
    minor_divisor: 100,
    quote_type: "EQUITY",
    isin: "GB00BP6MXD84",
    is_canonical: true,
    role: "canonical",
  });
  check("reference data seeded", Boolean(s1 && s2));

  // fresh delayed quotes in the cache so portfolio-refresh never calls Yahoo
  const future = new Date(Date.now() + 300_000).toISOString();
  const row = (symbol: string, price: number, currency: string, pct: number) => ({
    key: `quote:${symbol}`,
    payload: {
      symbol,
      currency,
      exchange: "X",
      regularMarketPrice: price,
      regularMarketTime: Date.now() - 60_000,
      regularMarketChangePercent: pct,
      marketState: "REGULAR",
      fetchedAt: new Date().toISOString(),
      stale: false,
    },
    provider: "yahoo",
    expires_at: future,
  });
  const quoteKeys = ["AAPL", "SHEL.L", "USDEUR=X", "GBPEUR=X"].map((s) => `quote:${s}`);
  const cacheUp = await admin
    .from("quote_cache")
    .upsert(
      [
        row("AAPL", 232, "USD", 1),
        row("SHEL.L", 2735, "GBp", 0.5),
        row("USDEUR=X", 0.93, "EUR", 0),
        row("GBPEUR=X", 1.16, "EUR", 0),
      ],
      { onConflict: "key" },
    );
  check("quote cache seeded", cacheUp.error === null, cacheUp.error?.message);
  restore.push(() => admin.from("quote_cache").delete().in("key", quoteKeys));

  // a linked connection for A (no real token: the fixture path never calls IBKR)
  const link = await admin
    .from("broker_connections")
    .upsert(
      { user_id: a.id, status: "linked", query_id: "123456", linked_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  check("linked connection seeded", link.error === null, link.error?.message);

  const ingest = () =>
    post("broker-sync", { action: "ingest_fixture", userId: a.id, xml }, { "x-cron-secret": cron });
  const first = await ingest();
  const firstBody = (await first.json()) as { run?: { state: string } };
  check(
    "fixture statement ingested through broker-sync worker mode",
    first.status === 200 && firstBody.run?.state === "done",
    `${first.status} ${JSON.stringify(firstBody)}`,
  );

  const expected = [2, 3, 2, 4, 2, 2];
  const before: number[] = [];
  for (const [i, t] of tables.entries()) {
    before.push(await count(admin, t, a.id));
    check(`rows in ${t}`, before[i] === expected[i], `${before[i]} != ${expected[i]}`);
  }
  const lots = await admin
    .from("broker_closed_lots")
    .select("fifo_pnl_realized")
    .eq("user_id", a.id);
  const sum = (lots.data ?? []).reduce((n, r) => n + Number(r.fifo_pnl_realized), 0);
  check(
    "partial-sale lots add up to the execution P/L (4.60)",
    Math.abs(sum - 4.6) < 1e-9,
    String(sum),
  );

  const pos = await admin
    .from("broker_positions")
    .select("symbol,security_id,signal_security_id,match_status")
    .eq("user_id", a.id);
  check(
    "both positions matched by ISIN",
    (pos.data ?? []).length === 2 &&
      (pos.data ?? []).every(
        (p) =>
          p.match_status === "matched_isin" &&
          p.security_id !== null &&
          p.signal_security_id !== null,
      ),
    JSON.stringify(pos.data),
  );

  await ingest();
  const after: number[] = [];
  for (const t of tables) after.push(await count(admin, t, a.id));
  check(
    "idempotent re-run: no duplicate rows",
    JSON.stringify(after) === JSON.stringify(before),
    `${after} vs ${before}`,
  );

  // isolation and secrets
  for (const t of tables) check(`user B sees no ${t} rows`, (await count(b.client, t)) === 0);
  check("user A sees own positions", (await count(a.client, "broker_positions")) === 2);
  const secret = await a.client.from("broker_connections").select("flex_token_ciphertext");
  check(
    "the owner cannot select the token ciphertext",
    secret.error?.code === "42501",
    JSON.stringify(secret.error),
  );
  const star = await a.client.from("broker_connections").select("*");
  check("select * on broker_connections is refused", star.error !== null);
  const write = await a.client
    .from("broker_connections")
    .update({ status: "unlinked" })
    .eq("user_id", a.id);
  check(
    "clients cannot write the connection",
    write.error !== null ||
      (await admin.from("broker_connections").select("status").eq("user_id", a.id).single()).data
        ?.status === "linked",
  );

  // portfolio-refresh: auth, valuation, cooldown
  const refresh = (jwt: string, manual: boolean) =>
    fetch(`${url}/functions/v1/portfolio-refresh`, {
      method: manual ? "POST" : "GET",
      headers: { authorization: `Bearer ${jwt}`, apikey: anon, "content-type": "application/json" },
      ...(manual ? { body: JSON.stringify({ manual: true }) } : {}),
    });
  check(
    "portfolio-refresh needs a JWT",
    (await fetch(`${url}/functions/v1/portfolio-refresh`, { headers: { apikey: anon } })).status ===
      401,
  );
  const g = await refresh(a.jwt, false);
  const gb = (await g.json()) as {
    view?: { positions: Array<{ ticker: string; price: { value: number } }> };
  };
  check(
    "GET values the positions with the cached delayed quotes (GBp converted)",
    g.status === 200 &&
      Math.abs((gb.view?.positions.find((p) => p.ticker === "SHEL")?.price.value ?? 0) - 27.35) <
        1e-9,
    `${g.status} ${JSON.stringify(gb).slice(0, 200)}`,
  );
  check("user B is not linked", (await refresh(b.jwt, false)).status === 409);

  const m1 = await refresh(a.jwt, true);
  const m2 = await refresh(a.jwt, true);
  check(
    "manual refresh: first 200, second 429 with Retry-After",
    m1.status === 200 && m2.status === 429 && Number(m2.headers.get("retry-after")) > 0,
    `${m1.status} ${m2.status}`,
  );

  await admin
    .from("broker_connections")
    .update({ last_manual_refresh_at: null })
    .eq("user_id", a.id);
  const burst = await Promise.all(Array.from({ length: 5 }, () => refresh(a.jwt, true)));
  const statuses = burst.map((r) => r.status).sort();
  check(
    "five parallel manual refreshes: exactly one passes",
    JSON.stringify(statuses) === JSON.stringify([200, 429, 429, 429, 429]),
    statuses.join(","),
  );

  // the worker endpoint refuses callers without the secret, fixture ingestion needs the secret too
  check(
    "broker-sync tick without the secret is 401",
    (await post("broker-sync", { action: "tick" }, {})).status === 401,
  );
  check(
    "a user JWT cannot ingest a fixture",
    (
      await post(
        "broker-sync",
        { action: "ingest_fixture", userId: a.id, xml },
        { authorization: `Bearer ${a.jwt}` },
      )
    ).status === 403,
  );
} finally {
  // users first: their broker rows (which reference the reference securities) cascade away with them
  await deleteUser(stack, a.id);
  await deleteUser(stack, b.id);
  for (const undo of restore.reverse()) await Promise.resolve(undo()).catch(() => undefined);
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("broker integration: all checks passed");
