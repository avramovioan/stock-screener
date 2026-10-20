import type { DiscountRow, OperationalCategory } from "@/features/screening/types";
import { type CardState, cardState } from "./card-state";

const CATEGORY_ORDER: Record<OperationalCategory, number> = {
  green: 0,
  amber: 1,
  red: 2,
  grey: 3,
  pending: 4,
};

/** A card is shown only for green or amber rows that are not withheld (spec 14.4, 4.8). */
export function isCleared(row: DiscountRow): boolean {
  return (
    !row.withheld && (row.operational_category === "green" || row.operational_category === "amber")
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Defensive stable sort: category, then rank, then symbol. The API already delivers this order. */
export function sortDiscounts(rows: readonly DiscountRow[]): DiscountRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        CATEGORY_ORDER[a.row.operational_category] - CATEGORY_ORDER[b.row.operational_category] ||
        a.row.rank - b.row.rank ||
        cmp(a.row.yahoo_symbol, b.row.yahoo_symbol) ||
        a.index - b.index,
    )
    .map((x) => x.row);
}

export function splitDiscounts(rows: readonly DiscountRow[]): {
  cards: DiscountRow[];
  withheld: DiscountRow[];
} {
  return {
    cards: sortDiscounts(rows.filter(isCleared)),
    withheld: sortDiscounts(rows.filter((r) => !isCleared(r))),
  };
}

const GROUP_ORDER: Record<CardState, number> = { cleared: 0, caution: 1, pending: 2, flagged: 3 };

/**
 * The Overview's one grid: cleared, then cleared with caution, then research pending (each by rank), then the flagged
 * cards (red, grey, withheld for another reason) last. `cards` and `flagged` are the two parts; `all` is the grid order.
 */
export function groupDiscounts(rows: readonly DiscountRow[]): {
  cards: DiscountRow[];
  flagged: DiscountRow[];
  all: DiscountRow[];
} {
  const sorted = sortDiscounts(rows)
    .map((row, index) => ({ row, index, state: cardState(row) }))
    .sort(
      (a, b) =>
        GROUP_ORDER[a.state] - GROUP_ORDER[b.state] ||
        a.row.rank - b.row.rank ||
        cmp(a.row.yahoo_symbol, b.row.yahoo_symbol) ||
        a.index - b.index,
    );
  return {
    cards: sorted.filter((x) => x.state !== "flagged").map((x) => x.row),
    flagged: sorted.filter((x) => x.state === "flagged").map((x) => x.row),
    all: sorted.map((x) => x.row),
  };
}
