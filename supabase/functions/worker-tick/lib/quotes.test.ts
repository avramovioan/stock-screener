import { assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { applyQuoteRows, snapshotInput } from "./quotes.ts";

const record = (symbol: string, marketCap: number): QuoteRecord => ({
  symbol,
  quoteType: "EQUITY",
  currency: "USD",
  financialCurrency: "USD",
  exchange: "NMS",
  fullExchangeName: "NasdaqGS",
  longName: `${symbol} Inc.`,
  shortName: null,
  marketCap: null, // Yahoo's own cap is never read (5.3)
  sharesOutstanding: marketCap,
  regularMarketPrice: 1,
  regularMarketTime: null,
  regularMarketPreviousClose: null,
  regularMarketChangePercent: null,
  marketState: null,
  firstTradeDateMs: null,
  exchangeTimezoneName: null,
  priceHint: null,
});

Deno.test("applyQuoteRows sends each symbol once even when the input repeats it", async () => {
  const sent: Array<Array<{ yahoo_symbol: string }>> = [];
  const sb = {
    schema: () => ({
      rpc: (_name: string, args: { p_rows: Array<{ yahoo_symbol: string }> }) => {
        sent.push(args.p_rows);
        return Promise.resolve({
          data: {
            created: args.p_rows.length,
            updated: 0,
            skipped_unknown_exchange: 0,
          },
          error: null,
        });
      },
    }),
  } as unknown as SupabaseClient;
  const out = await applyQuoteRows({
    sb,
    runId: "run-1",
    scanDay: 20_000,
    rows: [record("AAA", 5e9), record("BBB", 6e9), record("AAA", 5e9)],
    source: "yahoo_screener",
    fx: new Map(),
    thresholdUsd: 0,
    keepBelowThreshold: true,
    knownExchanges: new Set(["NMS"]),
  });
  assertEquals(
    sent.flat().map((r) => r.yahoo_symbol),
    ["AAA", "BBB"],
  );
  assertEquals(out.seen, 3);
  assertEquals(out.kept, 2);
});

Deno.test("applyQuoteRows keeps common shares only: bonds, ETFs and London IOB lines never reach the database", async () => {
  const sent: string[] = [];
  const sb = {
    schema: () => ({
      rpc: (_name: string, args: { p_rows: Array<{ yahoo_symbol: string }> }) => {
        sent.push(...args.p_rows.map((r) => r.yahoo_symbol));
        return Promise.resolve({
          data: {
            created: args.p_rows.length,
            updated: 0,
            skipped_unknown_exchange: 0,
          },
          error: null,
        });
      },
    }),
  } as unknown as SupabaseClient;
  const rows: QuoteRecord[] = [
    record("AAA", 5e9),
    { ...record("0J8P.L", 6e10), exchange: "NMS" },
    {
      ...record("ACALK.PA", 1e9),
      longName: "Crédit Agricole S.A. 1.3% SNR BDS 08/02/2027 EUR1",
    },
    { ...record("QQQ", 3e11), quoteType: "ETF" },
    { ...record("WARR", 1e9), quoteType: "WARRANT" },
  ];
  const out = await applyQuoteRows({
    sb,
    runId: "run-1",
    scanDay: 20_000,
    rows,
    source: "yahoo_screener",
    fx: new Map(),
    thresholdUsd: 0,
    keepBelowThreshold: true,
    knownExchanges: new Set(["NMS"]),
  });
  assertEquals(sent, ["AAA"]);
  assertEquals(out.seen, 5);
  assertEquals(out.kept, 1);
  assertEquals(out.skippedInstrument, 4);
});

const FX = new Map([
  [
    "USD",
    {
      ccy: "USD",
      usdPerUnit: 1,
      rateDate: "2026-10-19",
      source: "test",
    },
  ],
]);

Deno.test("snapshotInput computes the market cap as last price times shares outstanding", () => {
  const s = snapshotInput(
    {
      ...record("BRK", 133_905),
      regularMarketPrice: 130_000,
      regularMarketTime: 20_000 * 86_400_000,
    },
    FX,
    20_000,
  );
  assertEquals(s.marketCapNative, 17_407_650_000);
  assertEquals(s.marketCapUsd, 17_407_650_000);
  assertEquals(s.quality, "ok");
});

Deno.test("snapshotInput ignores Yahoo's marketCap and divides a minor-unit price into the major unit", () => {
  const row: QuoteRecord = {
    ...record("SHEL.L", 1_000),
    currency: "GBp",
    marketCap: 9e15,
    regularMarketPrice: 2_500,
    regularMarketTime: 20_000 * 86_400_000,
  };
  const s = snapshotInput(
    row,
    new Map([
      [
        "GBP",
        {
          ccy: "GBP",
          usdPerUnit: 1.25,
          rateDate: "2026-10-19",
          source: "test",
        },
      ],
    ]),
    20_000,
  );
  assertEquals(s.marketCapNative, 25_000);
  assertEquals(s.marketCapUsd, 31_250);
});

Deno.test("snapshotInput marks the quality missing when shares or price are absent", () => {
  const noShares = snapshotInput({ ...record("AAA", 5), sharesOutstanding: null }, FX, 20_000);
  assertEquals(noShares.quality, "missing");
  assertEquals(noShares.marketCapNative, null);
  assertEquals(noShares.marketCapUsd, null);
  const noPrice = snapshotInput({ ...record("AAA", 5), regularMarketPrice: null }, FX, 20_000);
  assertEquals(noPrice.quality, "missing");
});

Deno.test("applyQuoteRows applies the threshold to the computed value and stores it as market_cap_native", async () => {
  const sent: Array<{ yahoo_symbol: string; market_cap_native: number | null; quality: string }> =
    [];
  const sb = {
    schema: () => ({
      rpc: (_n: string, args: { p_rows: typeof sent }) => {
        sent.push(...args.p_rows);
        return Promise.resolve({
          data: { created: 0, updated: 0, skipped_unknown_exchange: 0 },
          error: null,
        });
      },
    }),
  } as unknown as SupabaseClient;
  const out = await applyQuoteRows({
    sb,
    runId: "r",
    scanDay: 20_000,
    rows: [
      { ...record("BIG", 1e9), regularMarketPrice: 10, marketCap: 1 }, // computed 1e10, Yahoo says 1
      { ...record("SMALL", 1e6), regularMarketPrice: 1, marketCap: 9e12 }, // computed 1e6, Yahoo says 9e12
    ],
    source: "yahoo_quote",
    fx: FX,
    thresholdUsd: 1e9,
    keepBelowThreshold: false,
    knownExchanges: new Set(["NMS"]),
  });
  assertEquals(out.belowThreshold, 1);
  assertEquals(
    sent.map((r) => [r.yahoo_symbol, r.market_cap_native]),
    [["BIG", 1e10]],
  );
});
