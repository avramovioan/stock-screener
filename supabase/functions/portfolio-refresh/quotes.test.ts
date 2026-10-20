import { assertEquals } from "@std/assert";
import { createCachedQuoteSource, type QuoteKv } from "./quotes.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function kv(
  initial: Record<string, { payload: unknown; fetchedAt: number; expiresAt: number }> = {},
) {
  const rows = new Map(Object.entries(initial));
  const puts: Array<{ key: string; expiresAt: number }> = [];
  const store: QuoteKv = {
    get: (keys) =>
      Promise.resolve(
        new Map(keys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k) as never])),
      ),
    put: (entries) => {
      for (const e of entries) {
        rows.set(e.key, { payload: e.payload, fetchedAt: e.fetchedAt, expiresAt: e.expiresAt });
        puts.push({ key: e.key, expiresAt: e.expiresAt });
      }
      return Promise.resolve();
    },
  };
  return { store, rows, puts };
}

const rec = (symbol: string, price: number, currency = "USD") => ({
  symbol,
  currency,
  exchange: "NMS",
  fullExchangeName: null,
  longName: null,
  regularMarketPrice: price,
  regularMarketTime: NOW - 120_000,
  regularMarketChangePercent: 0.5,
  marketState: "REGULAR",
});

Deno.test("fresh cache entries are used without calling the provider", async () => {
  const k = kv({
    "quote:AAPL": {
      payload: {
        ...rec("AAPL", 230),
        fetchedAt: new Date(NOW - 60_000).toISOString(),
        stale: false,
      },
      fetchedAt: NOW - 60_000,
      expiresAt: NOW + 240_000,
    },
  });
  let calls = 0;
  const src = createCachedQuoteSource({
    kv: k.store,
    market: {
      quote: () => {
        calls += 1;
        return Promise.resolve([]);
      },
    },
    nowMs: () => NOW,
  });
  const out = await src.quotes(["AAPL"]);
  assertEquals(calls, 0);
  assertEquals(out.error, null);
  assertEquals(out.map.get("AAPL")?.price, 230);
  assertEquals(out.map.get("AAPL")?.fetchedAtMs, NOW - 60_000);
});

Deno.test("misses and expired entries are fetched in one batch and cached for five minutes under quote:<symbol>", async () => {
  const k = kv({
    "quote:OLD": {
      payload: { ...rec("OLD", 1), fetchedAt: "x", stale: false },
      fetchedAt: NOW - 900_000,
      expiresAt: NOW - 600_000,
    },
  });
  const asked: string[][] = [];
  const src = createCachedQuoteSource({
    kv: k.store,
    market: {
      quote: (symbols) => {
        asked.push(symbols);
        return Promise.resolve([rec("AAPL", 232), rec("OLD", 2), rec("SHEL.L", 2735, "GBp")]);
      },
    },
    nowMs: () => NOW,
  });
  const out = await src.quotes(["AAPL", "OLD", "SHEL.L"]);
  assertEquals(asked, [["AAPL", "OLD", "SHEL.L"]]);
  assertEquals(out.map.get("SHEL.L")?.currency, "GBp");
  assertEquals(out.map.get("SHEL.L")?.price, 2735);
  assertEquals(
    k.puts.map((p) => [p.key, p.expiresAt - NOW]),
    [
      ["quote:AAPL", 300_000],
      ["quote:OLD", 300_000],
      ["quote:SHEL.L", 300_000],
    ],
  );
});

Deno.test("a provider failure falls back to the stale cache and reports the error; unknown symbols are simply missing", async () => {
  const k = kv({
    "quote:AAPL": {
      payload: { ...rec("AAPL", 229), fetchedAt: "x", stale: false },
      fetchedAt: NOW - 3_600_000,
      expiresAt: NOW - 3_300_000,
    },
  });
  const src = createCachedQuoteSource({
    kv: k.store,
    market: { quote: () => Promise.reject(new Error("429")) },
    nowMs: () => NOW,
  });
  const out = await src.quotes(["AAPL", "NOPE"]);
  assertEquals(out.map.get("AAPL")?.price, 229);
  assertEquals(out.map.has("NOPE"), false);
  assertEquals(out.error, "quote_provider_unavailable");

  const empty = createCachedQuoteSource({
    kv: kv().store,
    market: { quote: () => Promise.resolve([rec("AAPL", 232)]) },
    nowMs: () => NOW,
  });
  assertEquals((await empty.quotes(["AAPL", "NOPE"])).map.has("NOPE"), false);
  assertEquals((await empty.quotes([])).map.size, 0);
});

Deno.test("fx rates are Yahoo pair quotes (USDEUR=X) turned into rates dated by the quote time", async () => {
  const asked: string[][] = [];
  const src = createCachedQuoteSource({
    kv: kv().store,
    market: {
      quote: (symbols) => {
        asked.push(symbols);
        return Promise.resolve([rec("USDEUR=X", 0.93, "EUR"), rec("GBPEUR=X", 1.16, "EUR")]);
      },
    },
    nowMs: () => NOW,
  });
  const out = await src.fx([
    { from: "USD", to: "EUR" },
    { from: "GBP", to: "EUR" },
    { from: "XXX", to: "EUR" },
  ]);
  assertEquals(asked, [["USDEUR=X", "GBPEUR=X", "XXXEUR=X"]]);
  assertEquals(out.map.get("USD>EUR"), { rate: 0.93, rateDate: "2026-10-15", source: "yahoo" });
  assertEquals(out.map.get("GBP>EUR")?.rate, 1.16);
  assertEquals(out.map.has("XXX>EUR"), false);
});

Deno.test("cache keys are upper-cased and a cached quote older than one day is never served, even when the provider fails", async () => {
  const k = kv({
    "quote:SAP.DE": {
      payload: { ...rec("SAP.DE", 200, "EUR"), fetchedAt: "x", stale: false },
      fetchedAt: NOW - 60_000,
      expiresAt: NOW + 240_000,
    },
    "quote:OLD": {
      payload: { ...rec("OLD", 1), fetchedAt: "x", stale: false },
      fetchedAt: NOW - 90_000_000,
      expiresAt: NOW - 89_700_000,
    },
  });
  let calls = 0;
  const src = createCachedQuoteSource({
    kv: k.store,
    market: {
      quote: () => {
        calls += 1;
        return Promise.reject(new Error("down"));
      },
    },
    nowMs: () => NOW,
  });
  const out = await src.quotes(["sap.de", "old"]);
  assertEquals(out.map.get("sap.de")?.price, 200);
  assertEquals(out.map.has("old"), false);
  assertEquals([out.error, calls], ["quote_provider_unavailable", 1]);
});
