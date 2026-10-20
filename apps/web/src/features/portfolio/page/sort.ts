import type { Money } from "@core/accounting.ts";
import type { PositionView, ValuationTag } from "@core/portfolio-view.ts";

export type SortKey =
  | "ticker"
  | "name"
  | "price"
  | "quantity"
  | "cost"
  | "value"
  | "avgCost"
  | "daily"
  | "unrealized"
  | "tag";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Default sort of the brief: unrealized P&L ascending, the most negative first. */
export const DEFAULT_SORT: SortState = { key: "unrealized", dir: "asc" };

export const SORT_LABELS: Record<SortKey, string> = {
  ticker: "Ticker",
  name: "Name",
  price: "Price",
  quantity: "Quantity",
  cost: "Cost basis",
  value: "Market value",
  avgCost: "Average cost per unit",
  daily: "Daily P&L (estimated)",
  unrealized: "Unrealized P&L",
  tag: "Valuation tag",
};

const TAG_RANK: Record<ValuationTag, number | null> = {
  discounted: 0,
  none: 1,
  premium: 2,
  extra_premium: 3,
  unavailable: null,
};
const num = (m: Money): number | null => (m.kind === "ok" ? m.value : null);

function sortValue(r: PositionView, key: SortKey): string | number | null {
  switch (key) {
    case "ticker":
      return r.ticker.toUpperCase();
    case "name":
      return (r.name ?? "").toUpperCase();
    case "price":
      return r.price.value;
    case "quantity":
      return r.quantity;
    case "avgCost":
      return r.averageCost;
    case "cost":
      return num(r.costBase);
    case "value":
      return num(r.valueBase);
    case "daily":
      return num(r.dailyBase);
    case "unrealized":
      return num(r.unrealizedBase);
    case "tag":
      return TAG_RANK[r.tag];
  }
}

const cmp = (a: string | number, b: string | number): number => {
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return (a as number) - (b as number);
};

/** Unavailable values sort last in both directions; ties fall back to the ticker so the order is stable. */
export function sortPositions(
  rows: readonly PositionView[],
  key: SortKey,
  dir: SortDir,
): PositionView[] {
  const tie = (x: PositionView, y: PositionView) =>
    cmp(x.ticker.toUpperCase(), y.ticker.toUpperCase());
  return [...rows].sort((x, y) => {
    const a = sortValue(x, key);
    const b = sortValue(y, key);
    if (a === null && b === null) return tie(x, y);
    if (a === null) return 1;
    if (b === null) return -1;
    const c = cmp(a, b);
    return c === 0 ? tie(x, y) : dir === "asc" ? c : -c;
  });
}
