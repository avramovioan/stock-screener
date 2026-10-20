import {
  type Channel,
  computeChannel,
  DEFAULT_SETTINGS,
  type IndicatorSettings,
} from "../../supabase/functions/_shared/core/indicator.ts";
import {
  isDiscount,
  isPremium,
  lowerLinePositive,
} from "../../supabase/functions/_shared/core/thresholds.ts";

export interface ParitySeries {
  dates: string[];
  close: number[];
  high: number[];
  low: number[];
}
export interface ParityLine {
  name: "upper2" | "upper1" | "base" | "lower1" | "lower2";
  startDate: string;
  start: number;
  end: number;
}
export type ParityReport =
  | {
      ok: true;
      barCount: number;
      length: number;
      windowStartDate: string;
      lastDate: string;
      lastClose: number;
      stPrice: number;
      endPrice: number;
      stdDev: number;
      pearsonR: number;
      rising: boolean;
      lines: ParityLine[];
      lastBars: Array<{ date: string; close: number }>;
      classification: string[];
    }
  | { ok: false; reason: string };

export function buildParityReport(
  series: ParitySeries,
  opts: { asOf?: string; settings?: IndicatorSettings } = {},
): ParityReport {
  const keep = series.dates
    .map((d, i) => (opts.asOf === undefined || d <= opts.asOf ? i : -1))
    .filter((i) => i >= 0);
  const pick = (values: number[]) => keep.map((i) => values[i] as number);
  const dates = keep.map((i) => series.dates[i] as string);
  const outcome = computeChannel(
    { close: pick(series.close), high: pick(series.high), low: pick(series.low) },
    opts.settings ?? DEFAULT_SETTINGS,
  );
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const c: Channel = outcome.channel;
  const lastClose = pick(series.close)[c.lastIndex] as number;
  const line = (name: ParityLine["name"], seg: Channel["base"]): ParityLine => ({
    name,
    startDate: dates[seg.x1] as string,
    start: seg.y1,
    end: seg.y2,
  });
  const classification = [
    isPremium(lastClose, c.end.upper2) ? "close is above the +2 line (extra premium)" : null,
    isPremium(lastClose, c.end.upper1) ? "close is above the +1 line (premium)" : null,
    isDiscount(lastClose, c.end.lower1)
      ? `close is at or below the -3 line (discount, line end > 0: ${lowerLinePositive(c.end.lower1)})`
      : null,
    isDiscount(lastClose, c.end.lower2)
      ? `close is at or below the -4 line (discount, line end > 0: ${lowerLinePositive(c.end.lower2)})`
      : null,
  ].filter((s): s is string => s !== null);
  return {
    ok: true,
    barCount: c.barCount,
    length: c.length,
    windowStartDate: dates[c.windowStartIndex] as string,
    lastDate: dates[c.lastIndex] as string,
    lastClose,
    stPrice: c.stPrice,
    endPrice: c.endPrice,
    stdDev: c.stdDev,
    pearsonR: c.pearsonR,
    rising: c.rising,
    lines: [
      line("upper2", c.upper2),
      line("upper1", c.upper1),
      line("base", c.base),
      line("lower1", c.lower1),
      line("lower2", c.lower2),
    ],
    lastBars: keep
      .slice(-5)
      .map((i) => ({ date: series.dates[i] as string, close: series.close[i] as number })),
    classification:
      classification.length > 0 ? classification : ["no discount or premium condition holds"],
  };
}

export function formatParityReport(symbol: string, r: Extract<ParityReport, { ok: true }>): string {
  return [
    `symbol: ${symbol}`,
    `bars used: ${r.barCount} (length ${r.length}), window ${r.windowStartDate} .. ${r.lastDate}`,
    `last close: ${r.lastClose}`,
    `stPrice: ${r.stPrice}`,
    `endPrice: ${r.endPrice}`,
    `stdDev: ${r.stdDev}`,
    `pearsonR: ${r.pearsonR}`,
    `rising: ${r.rising}`,
    ...r.lines.map((l) => `${l.name}: start ${l.start} (${l.startDate}) end ${l.end}`),
    `classification: ${r.classification.join("; ")}`,
    "last 5 bars used (compare these against TradingView first):",
    ...r.lastBars.map((b) => `  ${b.date}  close ${b.close}`),
    "tolerance per level: |diff| <= 0.5 * 10^-p + 1e-9, p = the decimals TradingView displays for the symbol (spec 17.6, D10)",
  ].join("\n");
}
