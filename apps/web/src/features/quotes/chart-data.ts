import {
  type Channel,
  computeChannel,
  DEFAULT_SETTINGS,
  type IndicatorSettings,
  type OhlcSeries,
  type Segment,
  valueAt,
} from "@core/indicator.ts";

export const EXTENSION_BARS = 126;
export const RIGHT_MARGIN_BARS = 12;
export const DEFAULT_VIEW_MONTHS = 120;

export interface Bar {
  time: string; // YYYY-MM-DD (a Lightweight Charts business-day string)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface BarArrays {
  bar_dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export function dayToIso(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function barsFromArrays(a: BarArrays): Bar[] {
  return a.bar_dates.map((d, i) => ({
    time: dayToIso(d),
    open: a.open[i] ?? Number.NaN,
    high: a.high[i] ?? Number.NaN,
    low: a.low[i] ?? Number.NaN,
    close: a.close[i] ?? Number.NaN,
    volume: a.volume[i] ?? 0,
  }));
}

/** The next `count` weekdays after `lastIso` (holidays ignored: the lines are index-based like the script). */
export function nextWeekdays(lastIso: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${lastIso}T00:00:00Z`);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function lastNBars<T>(bars: readonly T[], n: number): T[] {
  return bars.length <= n ? [...bars] : bars.slice(bars.length - n);
}

/** Future weekday timestamps appended to the main series as whitespace so the x-axis exists to the right. */
export function whitespaceTimes(bars: readonly Bar[], extension = EXTENSION_BARS): string[] {
  const last = bars[bars.length - 1];
  return last ? nextWeekdays(last.time, extension) : [];
}

export type LineKey = "upper2" | "upper1" | "base" | "lower1" | "lower2";
export const LINE_KEYS: readonly LineKey[] = ["upper2", "upper1", "base", "lower1", "lower2"];
export const LINE_TITLES: Record<LineKey, string> = {
  upper2: "+2",
  upper1: "+1",
  base: "Base",
  lower1: "-3",
  lower2: "-4",
};

export interface LinePoint {
  time: string;
  value: number;
}
export interface ChannelLine {
  key: LineKey;
  title: string;
  points: LinePoint[];
}

export type ChannelData =
  | { status: "ok"; channel: Channel; lines: ChannelLine[] }
  | { status: "insufficient"; have: number; need: number }
  | { status: "invalid"; reason: string };

function ohlcOf(window: readonly Bar[]): OhlcSeries {
  return {
    close: window.map((b) => b.close),
    high: window.map((b) => b.high),
    low: window.map((b) => b.low),
  };
}

/**
 * Three points per line: left end, right end (last bar) and the extension at lastIndex + `extension`
 * computed with that segment's OWN drawn slope (`valueAt`). Set-2 segments already start at
 * windowStart + 1 (the core channel), so the offset is inherited, not re-derived here.
 */
export function buildChannelLines(
  window: readonly Bar[],
  channel: Channel,
  extension = EXTENSION_BARS,
): ChannelLine[] {
  const lastIdx = channel.lastIndex;
  const future = nextWeekdays((window[lastIdx] as Bar).time, extension);
  const timeAt = (i: number): string | undefined =>
    i <= lastIdx ? window[i]?.time : future[i - lastIdx - 1];
  const segments: Record<LineKey, Segment> = {
    base: channel.base,
    upper1: channel.upper1,
    upper2: channel.upper2,
    lower1: channel.lower1,
    lower2: channel.lower2,
  };
  return LINE_KEYS.map((key) => {
    const s = segments[key];
    const xs = extension > 0 ? [s.x1, s.x2, lastIdx + extension] : [s.x1, s.x2];
    const points: LinePoint[] = [];
    for (const x of xs) {
      const time = timeAt(x);
      if (time !== undefined) {
        points.push({ time, value: x === s.x1 ? s.y1 : x === s.x2 ? s.y2 : valueAt(s, x) });
      }
    }
    return { key, title: LINE_TITLES[key], points };
  });
}

/** Channel over the latest `settings.length` bars; fewer bars is "insufficient", never an error. */
export function computeChannelData(
  bars: readonly Bar[],
  settings: IndicatorSettings = DEFAULT_SETTINGS,
  extension = EXTENSION_BARS,
): ChannelData {
  const need = settings.length;
  if (bars.length < need) return { status: "insufficient", have: bars.length, need };
  const window = lastNBars(bars, need);
  const outcome = computeChannel(ohlcOf(window), settings);
  if (!outcome.ok) {
    return outcome.reason === "insufficient_bars"
      ? { status: "insufficient", have: bars.length, need }
      : { status: "invalid", reason: outcome.reason };
  }
  return {
    status: "ok",
    channel: outcome.channel,
    lines: buildChannelLines(window, outcome.channel, extension),
  };
}

export type RangeKey = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";
export const RANGE_KEYS: readonly RangeKey[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];
export interface LogicalRange {
  from: number;
  to: number;
}

export function subtractMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

function startIndexFor(months: number, bars: readonly { time: string }[]): number {
  const last = (bars[bars.length - 1] as { time: string }).time;
  const target = subtractMonths(last, months);
  const i = bars.findIndex((b) => b.time >= target);
  return i === -1 ? bars.length - 1 : i;
}

/** Display range over daily bars; always ends at lastIndex + 12 (the forward margin). Never touches the indicator. */
export function rangeToLogical(
  range: RangeKey,
  bars: readonly { time: string }[],
): LogicalRange | null {
  if (bars.length === 0) return null;
  const lastIndex = bars.length - 1;
  const to = lastIndex + RIGHT_MARGIN_BARS;
  let from: number;
  switch (range) {
    case "1D":
      from = lastIndex - 1;
      break;
    case "5D":
      from = lastIndex - 4;
      break;
    case "1M":
      from = startIndexFor(1, bars);
      break;
    case "6M":
      from = startIndexFor(6, bars);
      break;
    case "1Y":
      from = startIndexFor(12, bars);
      break;
    case "5Y":
      from = startIndexFor(60, bars);
      break;
    case "YTD": {
      const jan1 = `${(bars[lastIndex] as { time: string }).time.slice(0, 4)}-01-01`;
      const i = bars.findIndex((b) => b.time >= jan1);
      from = i === -1 ? lastIndex : i;
      break;
    }
    default:
      from = 0;
  }
  return { from: Math.max(0, Math.min(from, lastIndex)), to };
}

/** About ten calendar years ending at the last bar plus the margin (spec 14.5 initial view). */
export function defaultViewRange(bars: readonly { time: string }[]): LogicalRange | null {
  if (bars.length === 0) return null;
  const lastIndex = bars.length - 1;
  return { from: startIndexFor(DEFAULT_VIEW_MONTHS, bars), to: lastIndex + RIGHT_MARGIN_BARS };
}

/**
 * Channel values under the crosshair, from the core segments (not from the 3-point line series).
 * `logical` is the crosshair index on the main series (bars, then whitespace); the channel window is
 * the last `channel.lastIndex + 1` bars, so window index = logical - (barCount - windowLength).
 * A segment has a value only from its own x1 up to the +126-bar extension.
 */
export function channelValuesAt(
  channel: ChannelData,
  barCount: number,
  logical: number,
  extension = EXTENSION_BARS,
): Partial<Record<LineKey, number>> {
  const out: Partial<Record<LineKey, number>> = {};
  if (channel.status !== "ok") return out;
  const c = channel.channel;
  const x = Math.round(logical) - (barCount - (c.lastIndex + 1));
  if (x > c.lastIndex + extension) return out;
  const segments: Record<LineKey, Segment> = {
    upper2: c.upper2,
    upper1: c.upper1,
    base: c.base,
    lower1: c.lower1,
    lower2: c.lower2,
  };
  for (const key of LINE_KEYS) {
    const seg = segments[key];
    if (x >= seg.x1) out[key] = valueAt(seg, x);
  }
  return out;
}
