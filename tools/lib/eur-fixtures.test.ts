import { describe, expect, it } from "vitest";
import {
  buildEurFixtures,
  LOOKALIKE_CONID,
  LOOKALIKE_ISIN,
  MSFT_ISIN,
  type WorldSlice,
} from "./eur-fixtures.ts";

const world = (over: Record<string, unknown> = {}): WorldSlice => ({
  fx: { EUR: 1.1213, USD: 1 },
  securities: {
    MSFT: {
      quote: {
        symbol: "MSFT",
        quoteType: "EQUITY",
        currency: "USD",
        exchange: "NMS",
        longName: "Microsoft Corporation",
        sharesOutstanding: 7_425_545_491,
        regularMarketPrice: 533.69,
        regularMarketTime: "2026-10-14T20:00:00Z",
        ...over,
      },
    },
  },
});
const ibis = [
  {
    type: "STK",
    symbol: "MSF",
    localSymbol: "MSF",
    conid: 12178239,
    isin: MSFT_ISIN,
    currency: "EUR",
    description: "MICROSOFT CORP",
  },
];
const aeb = [
  {
    type: "STK",
    symbol: "ASML",
    localSymbol: "ASML",
    conid: 117589399,
    isin: "NL0010273215",
    currency: "EUR",
    description: "ASML HOLDING NV",
  },
];

describe("buildEurFixtures", () => {
  it("derives MSF.DE from the world's MSFT quote, inside the 1% tolerance", () => {
    const f = buildEurFixtures({ world: world(), ibisProducts: ibis, aebProducts: aeb });
    const q = f.quotes["MSF.DE"] as Record<string, unknown>;
    expect([
      q["symbol"],
      q["currency"],
      q["quoteType"],
      q["longName"],
      q["sharesOutstanding"],
    ]).toEqual(["MSF.DE", "EUR", "EQUITY", "Microsoft Corporation", 7_425_545_491]);
    const deviation = ((q["regularMarketPrice"] as number) * 1.1213 - 533.69) / 533.69;
    expect(Math.abs(deviation)).toBeLessThan(0.006);
  });

  it("adds the look-alike trap: an AEB row that shares MSFT's ticker, its ISIN pointing at the tracker line", () => {
    const f = buildEurFixtures({ world: world(), ibisProducts: ibis, aebProducts: aeb });
    const aebPage = (f.catalogue["AEB"]?.[0] ?? []) as {
      symbol: string;
      conid: number;
      isin: string;
    }[];
    const trap = aebPage.find((p) => p.symbol === "MSFT");
    expect(trap).toMatchObject({ conid: LOOKALIKE_CONID, isin: LOOKALIKE_ISIN });
    expect(f.isins).toEqual({ [MSFT_ISIN]: "MSFT", [LOOKALIKE_ISIN]: "MSFT.AS" });
    expect(f.quotes["MSFT.AS"]).toMatchObject({ quoteType: "ETF", currency: "EUR" });
    expect(f.catalogue["IBIS"]).toEqual([ibis]);
  });

  it("fails loudly when the world cannot support the scenario", () => {
    expect(() =>
      buildEurFixtures({
        world: { fx: { EUR: 1.1 }, securities: {} },
        ibisProducts: ibis,
        aebProducts: aeb,
      }),
    ).toThrow("no MSFT quote");
    expect(() =>
      buildEurFixtures({
        world: world({ regularMarketPrice: null }),
        ibisProducts: ibis,
        aebProducts: aeb,
      }),
    ).toThrow("regularMarketPrice");
    expect(() =>
      buildEurFixtures({
        world: world({ sharesOutstanding: undefined }),
        ibisProducts: ibis,
        aebProducts: aeb,
      }),
    ).toThrow("sharesOutstanding");
    expect(() =>
      buildEurFixtures({ world: { ...world(), fx: {} }, ibisProducts: ibis, aebProducts: aeb }),
    ).toThrow("EUR rate");
  });
});
