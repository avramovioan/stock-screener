import type { DiscountRow } from "@/features/screening/types";
import { formatPrice } from "@/lib/format";
import type { ResearchView } from "./research-state";

export type CardState = "cleared" | "caution" | "pending" | "flagged";

/** Where a feed row belongs: the four states of the cards-spec table. */
export function cardState(row: DiscountRow): CardState {
  const category = row.operational_category;
  const pendingReason =
    row.category_reason === "research_pending" || row.category_reason === "research_quota_deferred";
  if (category === "pending") return "pending";
  if (pendingReason && category !== "red" && category !== "grey") return "pending";
  if (!row.withheld && category === "green") return "cleared";
  if (!row.withheld && category === "amber") return "caution";
  return "flagged";
}

export type FlagTone = "red" | "grey";

const FLAG_LABELS: Record<string, string> = {
  bankruptcy_high: "High bankruptcy risk",
  material_damage: "Material damage established",
  does_not_meet: "Does not meet the checks",
  inconclusive: "Inconclusive",
  unmapped: "Inconclusive",
  research_failed: "Research failed",
};

/** The reason shown after "Flagged:" in the pill. */
export function flagLabel(row: DiscountRow): string {
  const known = FLAG_LABELS[row.category_reason];
  if (known) return known;
  if (row.operational_category === "red") return "Not cleared";
  if (row.operational_category === "grey") return "Inconclusive";
  return "Withheld";
}

/** Red rows use the flagged (destructive-family) tokens; grey and withheld rows the neutral ones. */
export function flagTone(row: DiscountRow): FlagTone {
  return row.operational_category === "red" ? "red" : "grey";
}

/** The reason as a sentence, for a card that has no report summary. */
export function reasonSentence(row: DiscountRow): string {
  return `${flagLabel(row)}.`;
}

/** The sentence that opens a "Cleared with caution" card body. */
export function cautionSentence(row: DiscountRow): string | null {
  return row.category_reason === "moderate_risk" ? "Moderate bankruptcy risk." : null;
}

/** (line end - close) / line end * 100; null when the line is unusable. Never negative. */
export function percentBelow(close: number, lineEnd: number): number | null {
  if (!Number.isFinite(close) || !Number.isFinite(lineEnd) || lineEnd <= 0) return null;
  return Math.max(0, ((lineEnd - close) / lineEnd) * 100);
}

/** One decimal, as shown: "1.9". */
export function formatPercentBelow(p: number): string {
  return p.toFixed(1);
}

/** The factual tag under the gauge. Flagged cards carry none; the verdict (Strong buy and the rest) lives in the header. */
export type DiscountTag = "reached" | "wait";

/** The factual line tag; every card has it, flagged ones too (only their verdict and state tags differ). */
export function discountTag(row: DiscountRow): DiscountTag | null {
  return row.reached_line4 ? "reached" : "wait";
}

/** The verdict pill next to the ticker. */
export type VerdictTag = "strong" | "consider" | "unchecked" | "avoid";

/**
 * Flagged is Avoid. Strong buy is a current, cleared (green) report on a top 10 company or one at its -4 line; a cleared
 * company outside both, and any cleared-with-caution report, is Consider. Everything without a current report
 * (not scanned, running, paused, failed, busy, no quota, expired) is Unchecked.
 */
export function verdictTag(row: DiscountRow, research: ResearchView): VerdictTag {
  const state = cardState(row);
  if (state === "flagged") return "avoid";
  if (research.kind !== "done") return "unchecked";
  if (state === "caution") return "consider";
  if (state === "cleared") return row.is_top10 || row.reached_line4 ? "strong" : "consider";
  return "unchecked";
}

/** "-4" with a real minus sign: "\u22124". */
export function lineName(threshold: string): string {
  return threshold.replace("-", "\u2212");
}

/** The gauge scale: 15% of the line gap of padding past the outermost of the close and the two lines. */
export function gaugeScale(close: number, line3: number, line4: number) {
  const gap = line3 - line4;
  const min = Math.min(close, line4) - 0.15 * gap;
  const max = Math.max(close, line3) + 0.15 * gap;
  const at = (value: number) => ((value - min) / (max - min)) * 100;
  return { close: at(close), line3: at(line3), line4: at(line4) };
}

/** Closer than this (percent of the track) and the two line labels share one right-aligned group. */
export const LABELS_MERGE_BELOW = 12;

export function labelsMerge(pos3: number, pos4: number): boolean {
  return pos3 - pos4 < LABELS_MERGE_BELOW;
}

export interface GaugeFacts {
  /** Percent below the -3 line, one decimal. */
  below3: string;
  /** Percent below the -4 line, one decimal; null until the close reaches it. */
  below4: string | null;
  /** How much lower the -4 line is than the close (the "wait" tag's second line), one decimal. */
  lower4: string;
  closeText: string;
  line3Price: string;
  line4Price: string;
  closePos: number;
  pos3: number;
  pos4: number;
  merged: boolean;
  ariaLabel: string;
}

/** Everything the gauge, its tag line and the flagged sentence print, or null when a line end is unusable. */
export function gaugeFacts(row: DiscountRow): GaugeFacts | null {
  const { close, line3_end: l3, line4_end: l4 } = row;
  const p3 = percentBelow(close, l3);
  const p4 = percentBelow(close, l4);
  if (p3 === null || p4 === null || !(l3 > l4)) return null;
  const lower4 = formatPercentBelow(Math.max(0, ((close - l4) / close) * 100));
  const scale = gaugeScale(close, l3, l4);
  const line3Price = formatPrice(l3, row.currency);
  const line4Price = formatPrice(l4, row.currency);
  const below3 = formatPercentBelow(p3);
  const below4 = row.reached_line4 ? formatPercentBelow(p4) : null;
  const ariaLabel = below4
    ? `Close is ${below3}% below its −3 line of ${line3Price} and ${below4}% below its −4 line of ${line4Price}`
    : `Close is ${below3}% below its −3 line of ${line3Price}. The −4 line, ${line4Price}, is ${lower4}% lower`;
  return {
    below3,
    below4,
    lower4,
    closeText: formatPrice(close, row.currency),
    line3Price,
    line4Price,
    closePos: scale.close,
    pos3: scale.line3,
    pos4: scale.line4,
    merged: labelsMerge(scale.line3, scale.line4),
    ariaLabel,
  };
}
