export interface CurrencyUnit {
  major: string;
  divisor: number;
}

// Only GBp is verified in the data (spike 3.3); ZAc, ILA and KWF follow Yahoo conventions (assumption A-03, verified in P1-04).
const MINOR_UNITS: ReadonlyMap<string, CurrencyUnit> = new Map<string, CurrencyUnit>([
  ["GBp", { major: "GBP", divisor: 100 }],
  ["ZAc", { major: "ZAR", divisor: 100 }],
  ["ILA", { major: "ILS", divisor: 100 }],
  ["KWF", { major: "KWD", divisor: 1000 }],
]);

/** GBp -> { major: "GBP", divisor: 100 }. Unknown codes pass through as { major: code, divisor: 1 }. */
export function resolveCurrency(code: string): CurrencyUnit {
  const unit = MINOR_UNITS.get(code);
  return unit === undefined
    ? { major: code, divisor: 1 }
    : { major: unit.major, divisor: unit.divisor };
}

/**
 * Converts a PRICE quoted in `code` into the major unit. Market caps are already reported in the
 * major unit by Yahoo (SHEL.L: currency GBp, marketCap in GBP), so they must never go through this function.
 */
export function toMajor(amount: number, code: string): number {
  return amount / resolveCurrency(code).divisor;
}
