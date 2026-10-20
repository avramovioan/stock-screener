// The home ticker of a listing: the exchange-local symbol a person recognises (spec 5.5). Pure.

/** Yahoo exchange codes of US exchanges; their symbols are shown unchanged. */
export const US_EXCHANGE_CODES: ReadonlySet<string> = new Set([
  "NYQ",
  "NMS",
  "NGM",
  "NCM",
  "ASE",
  "PCX",
  "BTS",
  "NYS",
  "NAS",
]);

/**
 * "RMS.PA" on Euronext Paris shows "RMS". On a US exchange the symbol stays as it is ("BRK.B");
 * dash forms ("BRK-B") and symbols without a suffix never change.
 */
export function displayTicker(yahooSymbol: string, exchangeCode: string): string {
  if (US_EXCHANGE_CODES.has(exchangeCode)) return yahooSymbol;
  const dot = yahooSymbol.lastIndexOf(".");
  return dot > 0 ? yahooSymbol.slice(0, dot) : yahooSymbol;
}
