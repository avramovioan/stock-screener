import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MemoryCacheStore } from "./cache.ts";
import { type HandlerDeps, handle } from "./handler.ts";
import type { ChartCompact, QuoteCore, QuotesProvider } from "./types.ts";

const SITE = "https://screener.example.com";
const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const BASE = "https://proj.supabase.co/functions/v1/quotes";

const core = (symbol: string): QuoteCore => ({
  symbol,
  currency: "USD",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  longName: `${symbol} Inc`,
  regularMarketPrice: 100,
  regularMarketTime: T0 - 60_000,
  regularMarketChangePercent: 1.5,
  marketState: "CLOSED",
});
const chartFor = (symbol: string): ChartCompact => ({
  symbol,
  currency: "USD",
  exchange: "NMS",
  exchangeTimezoneName: "America/New_York",
  longName: `${symbol} Inc`,
  bar_dates: [20000, 20001],
  open: [1, 2],
  high: [2, 3],
  low: [0, 1],
  close: [1.5, 2.5],
  volume: [10, 20],
  regularMarketTime: T0,
  marketState: "CLOSED",
});

function setup(
  over: { failProvider?: boolean; onSearch?: (store: MemoryCacheStore) => void } = {},
) {
  const store = new MemoryCacheStore();
  const calls = { search: [] as string[], quote: [] as string[][], chart: [] as string[] };
  let t = T0;
  const provider: QuotesProvider = {
    search(q) {
      calls.search.push(q);
      over.onSearch?.(store);
      if (over.failProvider) return Promise.reject(new Error("yahoo down"));
      return Promise.resolve([
        {
          symbol: "MSFT",
          exchange: "NMS",
          quoteType: "EQUITY",
          longName: "Microsoft",
          shortName: "MSFT",
        },
      ]);
    },
    quote(symbols) {
      calls.quote.push(symbols);
      if (over.failProvider) return Promise.reject(new Error("yahoo down"));
      return Promise.resolve(symbols.filter((s) => s !== "UNKNOWN").map(core));
    },
    chart(symbol) {
      calls.chart.push(symbol);
      if (over.failProvider) return Promise.reject(new Error("yahoo down"));
      return Promise.resolve(chartFor(symbol));
    },
  };
  const deps: HandlerDeps = {
    provider,
    store,
    now: () => t,
    sleep: () => Promise.resolve(),
    siteOrigin: SITE,
    rateLimitSalt: "test-salt-test-salt-test-salt-1234",
  };
  const req = (path: string, init: RequestInit & { ip?: string; origin?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", init.ip ?? "203.0.113.5");
    if (init.origin) headers.set("origin", init.origin);
    return new Request(`${BASE}${path}`, { ...init, headers });
  };
  const post = (path: string, body: unknown, ip?: string) =>
    req(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      ...(ip ? { ip } : {}),
    });
  return { deps, store, calls, req, post, advance: (ms: number) => (t += ms), now: () => t };
}

Deno.test("search: miss fills the cache, hit does not call the provider, TTL is 1 hour", async () => {
  const s = setup();
  const a = await handle(s.req("/search?q=Micro"), s.deps);
  assertEquals(a.status, 200);
  const body = await a.json();
  assertEquals(body.hits[0].symbol, "MSFT");
  assertEquals(body.stale, false);
  assertEquals(typeof body.fetchedAt, "string");
  await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(s.calls.search.length, 1);
  s.advance(3_600_000 + 1);
  await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(s.calls.search.length, 2);
});

Deno.test("search validates q", async () => {
  const s = setup();
  for (const path of [
    "/search",
    "/search?q=a",
    `/search?q=${"x".repeat(41)}`,
    "/search?q=%3Cb%3E",
  ]) {
    assertEquals((await handle(s.req(path), s.deps)).status, 400, path);
  }
  assertEquals(s.calls.search.length, 0);
});

Deno.test("quote: one batched provider call for misses, hits are reused, TTL is 5 minutes", async () => {
  const s = setup();
  const first = await handle(s.post("/quote", { symbols: ["msft", "aapl", "nvda"] }), s.deps);
  assertEquals(first.status, 200);
  const body = await first.json();
  assertEquals(
    body.quotes.map((q: QuoteCore) => q.symbol),
    ["MSFT", "AAPL", "NVDA"],
  );
  assertEquals(s.calls.quote, [["MSFT", "AAPL", "NVDA"]]);
  assertEquals(body.quotes[0].marketState, "CLOSED");
  assertEquals(typeof body.quotes[0].regularMarketTime, "number");
  const second = await handle(s.post("/quote", { symbols: ["MSFT", "AAPL", "TSLA"] }), s.deps);
  assertEquals((await second.json()).quotes.length, 3);
  assertEquals(s.calls.quote[1], ["TSLA"]);
  s.advance(300_001);
  await handle(s.post("/quote", { symbols: ["MSFT"] }), s.deps);
  assertEquals(s.calls.quote[2], ["MSFT"]);
});

Deno.test("quote: unknown symbols are reported as missing, not errors", async () => {
  const s = setup();
  const res = await handle(s.post("/quote", { symbols: ["MSFT", "UNKNOWN"] }), s.deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.missing, ["UNKNOWN"]);
  assertEquals(body.quotes.length, 1);
});

Deno.test("quote: validation returns 400 (51 symbols, bad symbol, bad JSON, empty)", async () => {
  const s = setup();
  const many = Array.from({ length: 51 }, (_, i) => `S${i}`);
  assertEquals((await handle(s.post("/quote", { symbols: many }), s.deps)).status, 400);
  assertEquals((await handle(s.post("/quote", { symbols: ["bad symbol"] }), s.deps)).status, 400);
  assertEquals((await handle(s.post("/quote", { symbols: [] }), s.deps)).status, 400);
  const badJson = s.req("/quote", {
    method: "POST",
    body: "{not json",
    headers: { "content-type": "application/json" },
  });
  assertEquals((await handle(badJson, s.deps)).status, 400);
  assertEquals(s.calls.quote.length, 0);
});

Deno.test("quote: stale-on-lock serves the expired value and does not call Yahoo", async () => {
  const s = setup();
  s.store.entries.set("quote:MSFT", {
    payload: core("MSFT"),
    fetchedAt: T0 - 600_000,
    expiresAt: T0 - 300_000,
  });
  s.store.entries.set("lock:quote:MSFT", { payload: null, fetchedAt: T0, expiresAt: T0 + 20_000 });
  const res = await handle(s.post("/quote", { symbols: ["MSFT"] }), s.deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.quotes[0].stale, true);
  assertEquals(body.stale, true);
  assertEquals(s.calls.quote.length, 0);
});

Deno.test("an expired lock is replaced and the provider is called", async () => {
  const s = setup();
  s.store.entries.set("lock:quote:MSFT", {
    payload: null,
    fetchedAt: T0 - 60_000,
    expiresAt: T0 - 40_000,
  });
  await handle(s.post("/quote", { symbols: ["MSFT"] }), s.deps);
  assertEquals(s.calls.quote.length, 1);
});

Deno.test("single-flight: the lock row exists during the fetch and is released afterwards", async () => {
  let lockSeen = false;
  const s = setup({ onSearch: (store) => (lockSeen = store.entries.has("lock:search:micro")) });
  await handle(s.req("/search?q=micro"), s.deps);
  assert(lockSeen, "lock:search:micro must exist while the provider runs");
  assertEquals(s.store.entries.has("lock:search:micro"), false);
});

Deno.test("locked and nothing cached: 503 with Retry-After", async () => {
  const s = setup();
  s.store.entries.set("lock:search:micro", {
    payload: null,
    fetchedAt: T0,
    expiresAt: T0 + 20_000,
  });
  const res = await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get("retry-after"), "2");
  assertEquals(s.calls.search.length, 0);
});

Deno.test("provider failure: 502 without a cached value, stale value with one; the lock is always released", async () => {
  const s = setup({ failProvider: true });
  const res = await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "upstream unavailable");
  assertEquals(s.store.entries.has("lock:search:micro"), false);
  s.store.entries.set("search:micro", {
    payload: [],
    fetchedAt: T0 - 7_200_000,
    expiresAt: T0 - 3_600_000,
  });
  const again = await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(again.status, 200);
  assertEquals((await again.json()).stale, true);
});

Deno.test("chart: miss calls the provider once, compact arrays, cached for a day under chart:<symbol>:v1", async () => {
  const s = setup();
  const res = await handle(s.req("/chart?symbol=msft"), s.deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.symbol, "MSFT");
  assertEquals(body.bar_dates, [20000, 20001]);
  assertEquals(body.close, [1.5, 2.5]);
  assertEquals(body.marketState, "CLOSED");
  assertEquals(body.stale, false);
  const entry = s.store.entries.get("chart:MSFT:v1");
  assert(entry);
  assertEquals(entry.expiresAt - entry.fetchedAt, 86_400_000);
  await handle(s.req("/chart?symbol=MSFT"), s.deps);
  assertEquals(s.calls.chart.length, 1);
  assertEquals((await handle(s.req("/chart?symbol=bad%20sym"), s.deps)).status, 400);
  assertEquals((await handle(s.req("/chart"), s.deps)).status, 400);
});

Deno.test("routing: unknown route 404, wrong method 405", async () => {
  const s = setup();
  assertEquals((await handle(s.req("/nope"), s.deps)).status, 404);
  assertEquals((await handle(s.req("/quote"), s.deps)).status, 405);
  assertEquals((await handle(s.post("/search?q=ab", {}), s.deps)).status, 405);
});

Deno.test("rate limit: 60 requests per minute per hashed IP, then 429; other IPs and the next minute are fine", async () => {
  const s = setup();
  for (let i = 0; i < 60; i++) {
    assertEquals((await handle(s.req("/search?q=micro"), s.deps)).status, 200, `request ${i + 1}`);
  }
  const blocked = await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(blocked.status, 429);
  assert(Number(blocked.headers.get("retry-after")) >= 1);
  assertEquals(
    (await handle(s.req("/search?q=micro", { ip: "198.51.100.9" }), s.deps)).status,
    200,
  );
  s.advance(60_000);
  assertEquals((await handle(s.req("/search?q=micro"), s.deps)).status, 200);
});

Deno.test("rate limit keys never contain the raw IP and change with the day (daily salt)", async () => {
  const s = setup();
  await handle(s.req("/search?q=micro", { ip: "203.0.113.77" }), s.deps);
  const day1 = [...s.store.counters.keys()];
  assertEquals(day1.length, 1);
  assert(!day1[0]?.includes("203.0.113.77"));
  assert(day1[0]?.startsWith("rl:quotes:"));
  s.advance(86_400_000);
  await handle(s.req("/search?q=micro", { ip: "203.0.113.77" }), s.deps);
  const hashPart = (k: string) => k.split(":")[2];
  const keys = [...s.store.counters.keys()];
  assert(hashPart(keys[0] as string) !== hashPart(keys[1] as string));
});

Deno.test("CORS: preflight from the site origin is allowed, from elsewhere is refused", async () => {
  const s = setup();
  const ok = await handle(s.req("/quote", { method: "OPTIONS", origin: SITE }), s.deps);
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), SITE);
  assertStringIncludes(ok.headers.get("access-control-allow-methods") ?? "", "POST");
  assertStringIncludes(ok.headers.get("access-control-allow-headers") ?? "", "apikey");
  const bad = await handle(
    s.req("/quote", { method: "OPTIONS", origin: "https://evil.example" }),
    s.deps,
  );
  assertEquals(bad.status, 403);
  assertEquals(bad.headers.get("access-control-allow-origin"), null);
});

Deno.test("CORS: only the site origin is echoed on real responses; Vary: Origin always", async () => {
  const s = setup();
  const good = await handle(s.req("/search?q=micro", { origin: SITE }), s.deps);
  assertEquals(good.headers.get("access-control-allow-origin"), SITE);
  assertStringIncludes(good.headers.get("vary") ?? "", "Origin");
  const foreign = await handle(
    s.req("/search?q=micro", { origin: "https://evil.example" }),
    s.deps,
  );
  assertEquals(foreign.headers.get("access-control-allow-origin"), null);
  const none = await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(none.headers.get("access-control-allow-origin"), null);
});

Deno.test("responses are not cacheable by intermediaries and carry JSON", async () => {
  const s = setup();
  const res = await handle(s.req("/search?q=micro"), s.deps);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
});
