// Best-effort Yahoo Finance symbol for a broker holding that is not matched to a screener
// security. Pure: no I/O. Returns null when no reliable Yahoo symbol can be derived.

const US_VENUES = new Set(["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS", "NYSENAT"]);

const SUFFIX_BY_EXCHANGE: Readonly<Record<string, string>> = {
  AEB: ".AS",
  IBIS: ".DE",
  IBIS2: ".DE",
  LSE: ".L",
  LSEETF: ".L",
  SBF: ".PA",
  EBS: ".SW",
  BVME: ".MI",
  BME: ".MC",
  SFB: ".ST",
  CPH: ".CO",
  HEX: ".HE",
  TSE: ".TO",
  ASX: ".AX",
  SEHK: ".HK",
};

export function yahooSymbolForHolding(
  symbol: string,
  listingExchange: string | null,
  assetClass: string | null,
): string | null {
  if (assetClass !== null && /bond/i.test(assetClass)) return null;
  if (symbol.trim() === "" || /\s/.test(symbol)) return null;
  if (listingExchange === null) return null;
  const ex = listingExchange.trim().toUpperCase();
  if (US_VENUES.has(ex)) return symbol.replace(/\./g, "-");
  const suffix = SUFFIX_BY_EXCHANGE[ex];
  return suffix === undefined ? null : `${symbol}${suffix}`;
}
