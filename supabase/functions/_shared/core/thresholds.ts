import type { Channel } from "./indicator.ts";

export type UniverseMode = "worldwide" | "us";
export type ThresholdLine = "-3" | "-4" | "+1" | "+2";
export type SignalKind = "discount" | "premium1" | "premium2";

/**
 * Every rank triggers on the -3 line (owner decision 2026-10-16, A-51). Rank decides only the tag (see discountTag), never whether a
 * discount exists. The rank parameter is kept so call sites read the same; it is intentionally ignored.
 */
export function applicableDiscountLine(_rank?: number | null): "-3" {
  return "-3";
}

export type DiscountTag = "strong_buy" | "reached_line4" | "wait_line4";

/** Tag of a discount card: the top 10 are a strong buy; the rest say whether the -4 line is already reached. */
export function discountTag(i: { isTop10: boolean; reachedLine4: boolean }): DiscountTag {
  return i.isTop10 ? "strong_buy" : i.reachedLine4 ? "reached_line4" : "wait_line4";
}

/** close <= the -4 line end (equality qualifies). Informational depth marker; never gates a discount. */
export function reachedLine4(close: number, line4End: number): boolean {
  return close <= line4End;
}

/** "-3" -> end.lower1, "-4" -> end.lower2, "+1" -> end.upper1, "+2" -> end.upper2 (exact right-end values at the latest bar). */
export function lineEnd(ch: Channel, line: ThresholdLine): number {
  switch (line) {
    case "-3":
      return ch.end.lower1;
    case "-4":
      return ch.end.lower2;
    case "+1":
      return ch.end.upper1;
    case "+2":
      return ch.end.upper2;
  }
}

/** close <= lowerEnd; equality qualifies, no epsilon. */
export function isDiscount(close: number, lowerEnd: number): boolean {
  return close <= lowerEnd;
}

/** close >= upperEnd; equality qualifies, no epsilon. */
export function isPremium(close: number, upperEnd: number): boolean {
  return close >= upperEnd;
}

/** Zero-line rule (D10): the applicable lower line end must be strictly above zero. */
export function lowerLinePositive(lowerEnd: number): boolean {
  return lowerEnd > 0;
}

export type HoldingTag = "discounted" | "premium" | "extra_premium" | "unavailable" | "none";

/**
 * Tag of a held security (8.6). Precedence: extra_premium > premium > discounted > none.
 * Non-equities and non-evaluable data are "unavailable". The worldwide rank does not matter: every holding uses the -3 line.
 */
export function classifyHolding(i: {
  evaluable: boolean;
  quoteType: string;
  close: number | null;
  end: Channel["end"] | null;
  worldwideRank: number | null;
}): HoldingTag {
  if (
    !i.evaluable ||
    i.quoteType !== "EQUITY" ||
    i.close === null ||
    !Number.isFinite(i.close) ||
    i.end === null ||
    ![i.end.base, i.end.upper1, i.end.upper2, i.end.lower1, i.end.lower2].every(Number.isFinite)
  )
    return "unavailable";
  if (isPremium(i.close, i.end.upper2)) return "extra_premium";
  if (isPremium(i.close, i.end.upper1)) return "premium";
  const lower = i.end.lower1;
  if (isDiscount(i.close, lower) && lowerLinePositive(lower)) return "discounted";
  return "none";
}
