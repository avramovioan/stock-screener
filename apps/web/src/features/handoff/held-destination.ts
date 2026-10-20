/** IBKR destinations (exchange codes) the hand-off accepts for a held instrument; anything else routes as SMART. */
const KNOWN_DESTINATIONS: ReadonlySet<string> = new Set([
  "NASDAQ",
  "NYSE",
  "ARCA",
  "AMEX",
  "BATS",
  "IBIS",
  "IBIS2",
  "AEB",
  "LSE",
  "LSEETF",
  "SBF",
  "EBS",
  "BVME",
  "BME",
  "SFB",
  "CPH",
  "HEX",
  "TSE",
  "ASX",
  "SEHK",
]);

/** `set destination <listing exchange>`: the statement code when IBKR knows it as a destination, SMART otherwise. */
export function heldDestination(listingExchange: string | null): {
  destination: string;
  fallback: boolean;
} {
  const code = (listingExchange ?? "").trim().toUpperCase();
  return KNOWN_DESTINATIONS.has(code)
    ? { destination: code, fallback: false }
    : { destination: "SMART", fallback: true };
}

/** One `ibkr_catalogue` row of a held instrument's ISIN (Xetra `IBIS` or Euronext Amsterdam `AEB`). */
export interface CatalogueRow {
  exchange: "IBIS" | "AEB";
  conid: number;
  localSymbol: string;
  currency: string;
}

export type HeldRouteNote = "xetra" | "amsterdam" | "statement";

export interface HeldRoute {
  destination: string;
  fallback: boolean;
  /** Symbol for the prompt: the catalogue row's local symbol for the chosen exchange, else the held symbol. */
  localSymbol: string;
  /** Catalogue conid of the chosen listing; null when the statement's own conid applies. */
  conid: number | null;
  currency: string | null;
  note: HeldRouteNote;
}

/**
 * Where a held instrument is traded from: Xetra when the catalogue lists the ISIN there (IBIS2 or IBIS per the user's default), else
 * Amsterdam, else the statement's listing exchange. `rows` null means no lookup result (none yet, or it failed).
 */
export function chooseHeldRoute(input: {
  rows: readonly CatalogueRow[] | null;
  preferred: string;
  held: { symbol: string; listingExchange: string | null };
}): HeldRoute {
  const rows = input.rows ?? [];
  const xetra = rows.find((r) => r.exchange === "IBIS");
  if (xetra !== undefined) {
    const destination =
      input.preferred === "IBIS2" || input.preferred === "IBIS" ? input.preferred : "IBIS";
    return {
      destination,
      fallback: false,
      localSymbol: xetra.localSymbol,
      conid: xetra.conid,
      currency: xetra.currency,
      note: "xetra",
    };
  }
  const ams = rows.find((r) => r.exchange === "AEB");
  if (ams !== undefined) {
    return {
      destination: "AEB",
      fallback: false,
      localSymbol: ams.localSymbol,
      conid: ams.conid,
      currency: ams.currency,
      note: "amsterdam",
    };
  }
  return {
    ...heldDestination(input.held.listingExchange),
    localSymbol: input.held.symbol,
    conid: null,
    currency: null,
    note: "statement",
  };
}
