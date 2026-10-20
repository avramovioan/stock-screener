import type { SearchHit } from "@/features/screening/quotes-api";
import type { DiscountRow } from "@/features/screening/types";
import { formatRankTicker, homeTicker } from "@/lib/format";

export interface Selection {
  symbol: string;
  exchangeCode: string | null;
  name: string | null;
  securityId: string | null;
  rank: number | null;
}

export const optionLabel = (r: DiscountRow): string =>
  `${formatRankTicker(r.rank, homeTicker(r.yahoo_symbol, r.exchange_code, r.listing_country))} — ${r.name}`;

export const selectionFromDiscount = (r: DiscountRow): Selection => ({
  symbol: r.yahoo_symbol,
  exchangeCode: r.exchange_code,
  name: r.name,
  securityId: r.security_id,
  rank: r.rank,
});

export const selectionFromHit = (h: SearchHit): Selection => ({
  symbol: h.symbol.toUpperCase(),
  exchangeCode: h.exchange,
  name: h.longName ?? h.shortName,
  securityId: null,
  rank: null,
});

/** Resolve the URL (`?sid=` / `?symbol=`) against today's cleared list; default to its first entry. */
export function pickSelection(
  cards: readonly DiscountRow[],
  params: { symbol?: string | undefined; sid?: string | undefined },
): Selection | null {
  if (params.sid) {
    const bySid = cards.find((c) => c.security_id === params.sid);
    if (bySid) return selectionFromDiscount(bySid);
  }
  if (params.symbol) {
    const sym = params.symbol.toUpperCase();
    const bySym = cards.find((c) => c.yahoo_symbol.toUpperCase() === sym);
    return bySym
      ? selectionFromDiscount(bySym)
      : { symbol: sym, exchangeCode: null, name: null, securityId: null, rank: null };
  }
  const first = cards[0];
  return first ? selectionFromDiscount(first) : null;
}
