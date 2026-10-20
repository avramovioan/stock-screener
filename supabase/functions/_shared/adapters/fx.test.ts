import { assert, assertEquals } from "@std/assert";
import { createFakeClock } from "./clock.ts";
import { jsonResponse, routeFetch } from "./fixtures.ts";
import { createFxProvider, fxRowFor } from "./fx.ts";
import type { QuoteRecord } from "./providers.ts";

// Recorded from https://api.frankfurter.dev/v1/latest?base=USD on 2026-10-15 (units of currency per USD)
const RECORDED = {
  amount: 1.0,
  base: "USD",
  date: "2026-10-14",
  rates: {
    AUD: 1.4266,
    BRL: 5.0242,
    CAD: 1.4219,
    CHF: 0.83341,
    CNY: 6.6927,
    EUR: 0.89326,
    GBP: 0.75377,
    HKD: 7.8481,
    ILS: 3.0766,
    INR: 95.16,
    JPY: 158.45,
    KRW: 1336.79,
    SEK: 9.9669,
    SGD: 1.2826,
    ZAR: 16.47,
  },
};

function frankfurterRoute(handler: (symbols: string[]) => Response | Promise<Response>) {
  return {
    match: (u: URL) => u.host === "api.frankfurter.dev" && u.pathname === "/v1/latest",
    respond: (u: URL) => {
      assertEquals(u.searchParams.get("base"), "USD");
      return handler((u.searchParams.get("symbols") ?? "").split(","));
    },
  };
}

/** Behaves like the live API: unsupported symbols are omitted; all unsupported -> 404. */
const realistic = (symbols: string[]) => {
  const rates = Object.fromEntries(
    symbols
      .filter((s) => s in RECORDED.rates)
      .map((s) => [s, (RECORDED.rates as Record<string, number>)[s]]),
  );
  return Object.keys(rates).length === 0
    ? jsonResponse({ message: "not found" }, 404)
    : jsonResponse({ ...RECORDED, rates });
};

const yahooQuote = (
  symbol: string,
  price: number,
  timeIso = "2026-10-15T07:00:00Z",
): QuoteRecord => ({
  symbol,
  quoteType: "CURRENCY",
  currency: "USD",
  financialCurrency: null,
  exchange: "CCY",
  fullExchangeName: "CCY",
  longName: null,
  shortName: null,
  marketCap: null,
  sharesOutstanding: null,
  regularMarketPrice: price,
  regularMarketTime: Date.parse(timeIso),
  regularMarketPreviousClose: null,
  regularMarketChangePercent: null,
  marketState: "REGULAR",
  firstTradeDateMs: null,
  exchangeTimezoneName: null,
  priceHint: 4,
});

Deno.test("Frankfurter: units per USD are inverted, USD is the identity, GBp is normalised to GBP, duplicates are removed", async () => {
  const fetchImpl = routeFetch([frankfurterRoute(realistic)]);
  const fx = createFxProvider({ fetchImpl, clock: createFakeClock() });
  const res = await fx.usdPerUnit(["EUR", "JPY", "GBP", "GBp", "USD", "EUR"]);
  assertEquals(res.missing, []);
  assertEquals(
    res.rates.map((r) => r.ccy),
    ["EUR", "GBP", "JPY", "USD"],
  );
  const eur = res.rates.find((r) => r.ccy === "EUR")!;
  assert(Math.abs(eur.usdPerUnit - 1 / 0.89326) < 1e-12);
  assertEquals([eur.rateDate, eur.source, eur.sourceSymbol], ["2026-10-14", "frankfurter", null]);
  assertEquals(res.rates.find((r) => r.ccy === "USD")?.usdPerUnit, 1);
  const url = new URL(fetchImpl.calls[0]!.url);
  assertEquals(url.searchParams.get("symbols"), "EUR,GBP,JPY"); // sorted, no USD
});

Deno.test("fallback: SAR and TWD (not covered by Frankfurter) come from Yahoo XXXUSD=X, with the UTC date of the quote", async () => {
  const fetchImpl = routeFetch([frankfurterRoute(realistic)]);
  const asked: string[][] = [];
  const fx = createFxProvider({
    fetchImpl,
    clock: createFakeClock(),
    quote: (symbols) => {
      asked.push(symbols);
      return Promise.resolve([
        yahooQuote("SARUSD=X", 0.266418),
        yahooQuote("TWDUSD=X", 0.030871822, "2026-10-14T21:59:00Z"),
        yahooQuote("EURUSD=X", 1.1216),
      ]);
    },
  });
  const res = await fx.usdPerUnit(["EUR", "SAR", "TWD"]);
  assertEquals(res.missing, []);
  assertEquals(asked, [["SARUSD=X", "TWDUSD=X", "EURUSD=X"]]); // one Yahoo call: the fallbacks plus the EUR cross-check
  const sar = res.rates.find((r) => r.ccy === "SAR")!;
  assertEquals(
    [sar.usdPerUnit, sar.source, sar.sourceSymbol, sar.rateDate],
    [0.266418, "yahoo", "SARUSD=X", "2026-10-15"],
  );
  assertEquals(res.rates.find((r) => r.ccy === "TWD")?.rateDate, "2026-10-14");
  assertEquals(res.rates.find((r) => r.ccy === "EUR")?.source, "frankfurter");
});

Deno.test("all requested symbols unsupported: Frankfurter answers 404 and everything falls back to Yahoo", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () =>
      Promise.resolve([
        yahooQuote("KWDUSD=X", 3.2456996),
        yahooQuote("AEDUSD=X", 0.27229407),
        yahooQuote("QARUSD=X", 0.2749141),
      ]),
  });
  const res = await fx.usdPerUnit(["KWD", "AED", "QAR"]);
  assertEquals(
    res.rates.map((r) => [r.ccy, r.source]),
    [
      ["AED", "yahoo"],
      ["KWD", "yahoo"],
      ["QAR", "yahoo"],
    ],
  );
  assertEquals(res.missing, []);
});

Deno.test("a currency known to neither source is reported missing", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("SARUSD=X", 0.266418)]),
  });
  const res = await fx.usdPerUnit(["SAR", "XXX"]);
  assertEquals(res.missing, ["XXX"]);
  assertEquals(
    res.rates.map((r) => r.ccy),
    ["SAR"],
  );
});

Deno.test("without a Yahoo quote function missing currencies stay missing", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
  });
  assertEquals((await fx.usdPerUnit(["EUR", "SAR"])).missing, ["SAR"]);
});

Deno.test("Frankfurter outage (HTTP 500 or network error): everything is fetched from Yahoo and an event is emitted", async () => {
  for (const respond of [
    () => new Response("boom", { status: 500 }),
    () => {
      throw new TypeError("offline");
    },
  ]) {
    const events: string[] = [];
    const fx = createFxProvider({
      fetchImpl: routeFetch([frankfurterRoute(respond)]),
      clock: createFakeClock(),
      quote: () => Promise.resolve([yahooQuote("EURUSD=X", 1.1216)]),
      onEvent: (e) => events.push(e),
    });
    const res = await fx.usdPerUnit(["EUR"]);
    assertEquals(
      res.rates.map((r) => [r.ccy, r.source]),
      [["EUR", "yahoo"]],
    );
    assert(events.includes("fx_frankfurter_failed"));
  }
});

Deno.test("sanity: zero, null and absurd rates are rejected", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([
      frankfurterRoute(() =>
        jsonResponse({ ...RECORDED, rates: { EUR: 0, GBP: null, JPY: 1e-12, CHF: 0.83341 } }),
      ),
    ]),
    clock: createFakeClock(),
  });
  const res = await fx.usdPerUnit(["EUR", "GBP", "JPY", "CHF"]);
  assertEquals(
    res.rates.map((r) => r.ccy),
    ["CHF"],
  );
  assertEquals(res.missing, ["EUR", "GBP", "JPY"]);
});

Deno.test("sources disagreeing by more than 2% log fx_source_disagreement and keep Frankfurter", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("EURUSD=X", 1.16)]), // Frankfurter says 1.1195 -> 3.6% apart
    onEvent: (e, d) => events.push([e, d]),
  });
  const res = await fx.usdPerUnit(["EUR"]);
  assertEquals(res.rates[0]?.source, "frankfurter");
  assertEquals(
    events.map((e) => e[0]),
    ["fx_source_disagreement"],
  );
  assertEquals(events[0]![1]["ccy"], "EUR");
});

Deno.test("agreeing sources log nothing", async () => {
  const events: string[] = [];
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("EURUSD=X", 1.1213)]),
    onEvent: (e) => events.push(e),
  });
  await fx.usdPerUnit(["EUR"]);
  assertEquals(events, []);
});

Deno.test("fxRowFor maps an FxQuote to the fx_rates columns", () => {
  assertEquals(
    fxRowFor("SAR", {
      ccy: "SAR",
      usdPerUnit: 0.266418,
      rateDate: "2026-10-15",
      source: "yahoo",
      sourceSymbol: "SARUSD=X",
    }),
    {
      ccy: "SAR",
      usd_per_unit: 0.266418,
      rate_date: "2026-10-15",
      source: "yahoo",
      source_symbol: "SARUSD=X",
    },
  );
});
