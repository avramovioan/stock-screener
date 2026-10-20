import { assert, assertEquals, assertRejects } from "@std/assert";
import { type CacheEntry, MemoryCacheStore } from "./cache.ts";
import { type HandlerDeps, handle } from "./handler.ts";
import { getQuotes } from "./service.ts";
import type { QuoteCore, QuotesProvider } from "./types.ts";

const SITE = "https://screener.example.com";
const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

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

function setup(store: MemoryCacheStore = new MemoryCacheStore(), fail = false) {
  const calls: string[][] = [];
  const provider: QuotesProvider = {
    search: () => Promise.resolve([]),
    quote(symbols) {
      calls.push(symbols);
      if (fail) return Promise.reject(new Error("yahoo down"));
      return Promise.resolve(symbols.filter((s) => s !== "UNKNOWN").map(core));
    },
    chart: () => Promise.reject(new Error("unused")),
  };
  const deps: HandlerDeps = {
    provider,
    store,
    now: () => T0,
    sleep: () => Promise.resolve(),
    siteOrigin: SITE,
    rateLimitSalt: "test-salt-test-salt-test-salt-1234",
  };
  const post = (symbols: string[]) =>
    handle(
      new Request("https://proj.supabase.co/functions/v1/quotes/quote", {
        method: "POST",
        body: JSON.stringify({ symbols }),
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
      }),
      deps,
    );
  return { store, calls, deps, post };
}

const lock = (store: MemoryCacheStore, sym: string) =>
  store.entries.set(`lock:quote:${sym}`, { payload: null, fetchedAt: T0, expiresAt: T0 + 20_000 });
const stale = (store: MemoryCacheStore, sym: string) =>
  store.entries.set(`quote:${sym}`, {
    payload: core(sym),
    fetchedAt: T0 - 600_000,
    expiresAt: T0 - 300_000,
  });

Deno.test("quote: all symbols locked and nothing cached gives 503 with Retry-After 2, not an empty 200", async () => {
  const s = setup();
  lock(s.store, "MSFT");
  lock(s.store, "AAPL");
  const res = await s.post(["MSFT", "AAPL"]);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get("retry-after"), "2");
  assertEquals(s.calls.length, 0);
  assert(s.store.entries.has("lock:quote:MSFT"), "foreign lock must survive");
  assert(s.store.entries.has("lock:quote:AAPL"), "foreign lock must survive");
});

Deno.test("quote: partially locked lists the locked symbol as unavailable, not missing", async () => {
  const s = setup();
  lock(s.store, "AAPL");
  const res = await s.post(["MSFT", "AAPL", "UNKNOWN"]);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(
    body.quotes.map((q: QuoteCore) => q.symbol),
    ["MSFT"],
  );
  assertEquals(body.unavailable, ["AAPL"]);
  assertEquals(body.missing, ["UNKNOWN"]);
  assertEquals(body.stale, false);
  assertEquals(s.calls, [["MSFT", "UNKNOWN"]]);
});

Deno.test("quote: locked with an expired value serves it stale and flags the response stale", async () => {
  const s = setup();
  lock(s.store, "AAPL");
  stale(s.store, "AAPL");
  const body = await (await s.post(["MSFT", "AAPL"])).json();
  assertEquals(body.stale, true);
  assertEquals(body.unavailable, []);
  assertEquals(body.quotes[1].stale, true);
});

Deno.test("quote: provider failure with nothing servable is 502 and releases the locks", async () => {
  const s = setup(new MemoryCacheStore(), true);
  const res = await s.post(["MSFT", "AAPL"]);
  assertEquals(res.status, 502);
  assertEquals(
    [...s.store.entries.keys()].filter((k) => k.startsWith("lock:")),
    [],
  );
});

Deno.test("quote: provider failure with some cached values reports the rest as unavailable", async () => {
  const s = setup(new MemoryCacheStore(), true);
  s.store.entries.set("quote:MSFT", {
    payload: core("MSFT"),
    fetchedAt: T0,
    expiresAt: T0 + 100_000,
  });
  stale(s.store, "NVDA");
  const body = await (await s.post(["MSFT", "AAPL", "NVDA"])).json();
  assertEquals(
    body.quotes.map((q: QuoteCore) => q.symbol),
    ["MSFT", "NVDA"],
  );
  assertEquals(body.unavailable, ["AAPL"]);
  assertEquals(body.missing, []);
  assertEquals(body.stale, true);
});

Deno.test("quote: a store failure while locking releases the locks taken so far", async () => {
  const store = new MemoryCacheStore();
  // Models a store that takes the first lock, then fails on the second symbol.
  store.tryLockMany = (keys, nowMs, ttlMs) => {
    store.entries.set(`lock:${keys[0]}`, {
      payload: null,
      fetchedAt: nowMs,
      expiresAt: nowMs + ttlMs,
    });
    return Promise.reject(new Error(`lock failed on ${keys[1]}`));
  };
  const s = setup(store);
  await assertRejects(() => getQuotes(s.deps, ["MSFT", "AAPL"]), Error, "lock failed");
  assertEquals(store.entries.has("lock:quote:MSFT"), false);
  assertEquals(s.calls.length, 0);
});

Deno.test("quote: a failing cache write still serves the fresh quotes and releases every lock", async () => {
  const store = new MemoryCacheStore();
  store.putMany = () => Promise.reject(new Error("write failed"));
  const s = setup(store);
  const res = await s.post(["MSFT", "AAPL"]);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(
    body.quotes.map((q: QuoteCore) => q.symbol),
    ["MSFT", "AAPL"],
  );
  assertEquals(body.stale, false);
  assertEquals(
    [...store.entries.keys()].filter((k) => k.startsWith("lock:")),
    [],
  );
});

Deno.test("quote: 50 uncached symbols use a bounded number of store calls", async () => {
  const s = setup();
  const symbols = Array.from({ length: 50 }, (_, i) => `S${i}`);
  const body = await (await s.post(symbols)).json();
  assertEquals(body.quotes.length, 50);
  assert(s.store.calls <= 6, `store calls: ${s.store.calls}`);
  assertEquals(s.calls.length, 1);
  const before = s.store.calls;
  await s.post(symbols); // all fresh: one read
  assert(s.store.calls - before <= 6);
  const hit: CacheEntry | undefined = s.store.entries.get("quote:S0");
  assert(hit);
});
