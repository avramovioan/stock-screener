import { assertEquals } from "@std/assert";
import { type EurFixtures, withEurFixtures } from "./fixture-eur.ts";
import type { MarketDataProvider, QuoteRecord } from "./providers.ts";

const eur: EurFixtures = {
  catalogue: {},
  isins: { US5949181045: "MSFT" },
  quotes: {
    "MSF.DE": {
      symbol: "MSF.DE",
      currency: "EUR",
      exchange: "GER",
      quoteType: "EQUITY",
      longName: "Microsoft Corporation",
      regularMarketPrice: 472.85,
      regularMarketTime: "2026-10-15T07:00:00Z",
      sharesOutstanding: 7_425_545_491,
    },
  },
};

const baseQuote = (symbol: string): QuoteRecord => ({
  symbol,
  quoteType: "EQUITY",
  currency: "USD",
  financialCurrency: null,
  exchange: "NMS",
  fullExchangeName: null,
  longName: "Base",
  shortName: null,
  marketCap: null,
  sharesOutstanding: null,
  regularMarketPrice: 1,
  regularMarketTime: null,
  regularMarketPreviousClose: null,
  regularMarketChangePercent: null,
  marketState: null,
  firstTradeDateMs: null,
  exchangeTimezoneName: null,
  priceHint: null,
});

function base(): MarketDataProvider & { quoted: string[][]; searched: string[] } {
  const quoted: string[][] = [];
  const searched: string[] = [];
  const stub = {
    id: "fixture",
    quoted,
    searched,
    search(q: string) {
      searched.push(q);
      return Promise.resolve({ hits: [], news: [] });
    },
    quote(symbols: string[]) {
      quoted.push(symbols);
      return Promise.resolve(symbols.map(baseQuote));
    },
  };
  return stub as unknown as MarketDataProvider & { quoted: string[][]; searched: string[] };
}

Deno.test("search: a fixture ISIN answers with its primary symbol, anything else falls through", async () => {
  const b = base();
  const m = withEurFixtures(b, eur);
  assertEquals(
    (await m.search("US5949181045")).hits.map((h) => h.symbol),
    ["MSFT"],
  );
  assertEquals(b.searched, []);
  assertEquals((await m.search("DE0007164600")).hits, []);
  assertEquals(b.searched, ["DE0007164600"]);
});

Deno.test("quote: fixture lines are mapped, the other symbols go to the base provider only", async () => {
  const b = base();
  const out = await withEurFixtures(b, eur).quote(["MSFT", "MSF.DE"]);
  assertEquals(b.quoted, [["MSFT"]]);
  assertEquals(out.map((q) => [q.symbol, q.currency, q.regularMarketPrice]).sort(), [
    ["MSF.DE", "EUR", 472.85],
    ["MSFT", "USD", 1],
  ]);
  assertEquals(out.find((q) => q.symbol === "MSF.DE")?.sharesOutstanding, 7_425_545_491);
  const only = base();
  await withEurFixtures(only, eur).quote(["MSF.DE"]);
  assertEquals(only.quoted, [], "no base call when every symbol is a fixture line");
});
