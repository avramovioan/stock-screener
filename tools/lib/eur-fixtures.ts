// Builds the offline EUR data for the integration scan (7.12, 17.4) from the integration world and the IBKR catalogue fixtures.
// Pure: the CLI (tools/gen-eur-fixtures.ts) reads and writes the files. Everything here is SYNTHETIC test data derived from the world's MSFT quote.

export const MSFT_ISIN = "US5949181045";
export const LOOKALIKE_ISIN = "XS0000000010";
export const LOOKALIKE_CONID = 900000010;

export interface WorldSlice {
  fx: Record<string, number>;
  securities: Record<string, { quote: Record<string, unknown> }>;
}

export interface EurFixtures {
  catalogue: Record<string, unknown[][]>;
  isins: Record<string, string>;
  quotes: Record<string, Record<string, unknown>>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildEurFixtures(input: {
  world: WorldSlice;
  ibisProducts: unknown[];
  aebProducts: unknown[];
}): EurFixtures {
  const msft = input.world.securities["MSFT"]?.quote;
  if (msft === undefined) throw new Error("the integration world has no MSFT quote");
  const price = msft["regularMarketPrice"];
  const shares = msft["sharesOutstanding"];
  const name = msft["longName"];
  const eurUsd = input.world.fx["EUR"];
  if (typeof price !== "number" || !(price > 0))
    throw new Error("world MSFT has no regularMarketPrice");
  if (typeof shares !== "number" || !(shares > 0))
    throw new Error("world MSFT has no sharesOutstanding");
  if (typeof name !== "string" || name === "") throw new Error("world MSFT has no longName");
  if (typeof eurUsd !== "number" || !(eurUsd > 0))
    throw new Error("world fx has no EUR rate (USD per EUR)");

  // MSF.DE: the same company on Xetra, 0.4% away from MSFT x FX (spike 3.5 measured 0.65%): inside the 1% tolerance
  const msfDe: Record<string, unknown> = {
    ...msft,
    symbol: "MSF.DE",
    quoteType: "EQUITY",
    currency: "EUR",
    exchange: "GER",
    fullExchangeName: "XETRA",
    regularMarketPrice: round2((price / eurUsd) * 1.004),
  };
  // MSFT.AS: the tracker ETP that shares MSFT's ticker on Euronext Amsterdam (spike 3.5)
  const msftAs: Record<string, unknown> = {
    symbol: "MSFT.AS",
    quoteType: "ETF",
    currency: "EUR",
    exchange: "AMS",
    fullExchangeName: "Amsterdam",
    longName: "LS 1x Microsoft Tracker ETP Securities",
    regularMarketPrice: 9.664,
    regularMarketTime: msft["regularMarketTime"] ?? null,
  };
  const lookAlike = {
    type: "STK",
    symbol: "MSFT",
    exchangeId: "AEB",
    localSymbol: "MSFT",
    description: "SYNTHETIC LOOK-ALIKE TRACKER (TEST ONLY)",
    conid: LOOKALIKE_CONID,
    isin: LOOKALIKE_ISIN,
    currency: "EUR",
    country: "NL",
  };
  return {
    catalogue: { IBIS: [input.ibisProducts], AEB: [[...input.aebProducts, lookAlike]] },
    isins: { [MSFT_ISIN]: "MSFT", [LOOKALIKE_ISIN]: "MSFT.AS" },
    quotes: { "MSF.DE": msfDe, "MSFT.AS": msftAs },
  };
}
