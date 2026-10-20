import { NO_FILTERS, type TradeFilters, type TradeSide, type TradeType } from "./trades-api";

/** The `/portfolio` search: the trade history filters, mirrored in the address so a filtered view can be bookmarked. */
export interface PortfolioSearch {
  q?: string;
  type?: Exclude<TradeType, "all">;
  side?: Exclude<TradeSide, "all">;
  ccy?: string;
  from?: string;
  to?: string;
}

const TYPES: readonly string[] = ["stocks", "fx", "bonds"];
const SIDES: readonly string[] = ["BUY", "SELL"];

function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** TanStack Router `validateSearch` for `/portfolio`. Invalid input is dropped, never thrown. */
export function validatePortfolioSearch(raw: Record<string, unknown>): PortfolioSearch {
  const out: PortfolioSearch = {};
  if (typeof raw["q"] === "string" && raw["q"].trim() !== "") out.q = raw["q"].trim();
  if (typeof raw["type"] === "string" && TYPES.includes(raw["type"]))
    out.type = raw["type"] as PortfolioSearch["type"] & string;
  if (typeof raw["side"] === "string" && SIDES.includes(raw["side"]))
    out.side = raw["side"] as PortfolioSearch["side"] & string;
  if (typeof raw["ccy"] === "string" && /^[A-Za-z]{3}$/.test(raw["ccy"]))
    out.ccy = raw["ccy"].toUpperCase();
  if (isDay(raw["from"])) out.from = raw["from"];
  if (isDay(raw["to"])) out.to = raw["to"];
  return out;
}

export function filtersFromSearch(search: PortfolioSearch): TradeFilters {
  return {
    q: search.q ?? NO_FILTERS.q,
    type: search.type ?? NO_FILTERS.type,
    side: search.side ?? NO_FILTERS.side,
    ccy: search.ccy ?? NO_FILTERS.ccy,
    from: search.from ?? NO_FILTERS.from,
    to: search.to ?? NO_FILTERS.to,
  };
}

/** Only non-default filters are written to the address. */
export function searchFromFilters(f: TradeFilters): PortfolioSearch {
  const out: PortfolioSearch = {};
  if (f.q !== "") out.q = f.q;
  if (f.type !== "all") out.type = f.type;
  if (f.side !== "all") out.side = f.side;
  if (f.ccy !== "") out.ccy = f.ccy;
  if (f.from !== "") out.from = f.from;
  if (f.to !== "") out.to = f.to;
  return out;
}
