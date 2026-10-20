import { expectedWeekdays, localDayNumber, localParts } from "./calendar.ts";

export interface RawBar {
  time: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface ChartMeta {
  exchangeTimezoneName: string; // IANA, e.g. "Europe/Berlin"
  regularMarketTime: number | null; // epoch ms of the last regular-session trade
  currentTradingPeriod: { start: number; end: number } | null; // regular session of the current-or-next session, epoch ms
  marketState?: string; // from quote(): REGULAR | PRE | PREPRE | POST | POSTPOST | CLOSED
  /** Fallback close "HH:MM" (exchanges.session_close_local) used only when currentTradingPeriod is null. */
  sessionCloseLocal?: string | null;
}

export interface Series {
  dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface CleanReport {
  inputBars: number;
  keptBars: number;
  droppedNullClose: number;
  droppedNullHighLow: number;
  droppedNonPositive: number;
  droppedDuplicates: number;
  droppedForming: boolean;
  ohlcInconsistent: number; // close outside [low, high] beyond 1e-6 relative: kept, counted
  jumpAnomalies: number; // |close/prev - 1| > 0.5: kept, counted (A-16)
  missingSessionRatio: number; // 1 - kept / expected weekdays in the span (A-16)
  suspect: boolean; // jumpAnomalies >= 3 || missingSessionRatio > 0.15 (A-16)
}

export const FORMING_MARGIN_MS = 30 * 60_000; // safety margin after the regular session end (A-10)
export const OHLC_TOLERANCE = 1e-6;
export const JUMP_THRESHOLD = 0.5;
export const SUSPECT_JUMPS = 3;
export const SUSPECT_MISSING_RATIO = 0.15;
export const ADJUSTMENT_DRIFT_TOLERANCE = 1e-4;
const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** Exchange-local date of a session-open instant as days since 1970-01-01. */
export function sessionDay(epochMs: number, tz: string): number {
  return localDayNumber(epochMs, tz);
}

function localMinutesOfDay(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return p.hour * 60 + p.minute;
}

/**
 * Forming-bar rule (spec 4.3.1). currentTradingPeriod always describes the current-or-next regular session.
 *   completed := last.time < period.start OR regularMarketTime >= period.end
 *   forming   := NOT completed OR (marketState == "REGULAR" AND the bar is of today's local day)
 *                OR (sessionDay(last) == today in the exchange zone AND now < end of that session + 30 min)
 * Without currentTradingPeriod: forming iff the bar's day is today and (when sessionCloseLocal is known) local time < close + 30 min.
 */
export function isFormingLastBar(lastBarMs: number, meta: ChartMeta, nowMs: number): boolean {
  const tz = meta.exchangeTimezoneName;
  const lastDay = sessionDay(lastBarMs, tz);
  const today = localDayNumber(nowMs, tz);
  // A REGULAR market state means today's session is in progress. A bar of an earlier local day is a completed session
  // (Yahoo may not have created today's bar yet), so it is never dropped on the state alone.
  if (meta.marketState === "REGULAR" && lastDay >= today) return true;
  const period = meta.currentTradingPeriod;

  if (period === null) {
    if (lastDay !== today) return false;
    const close = meta.sessionCloseLocal ?? null;
    if (close === null) return true; // cannot prove the session is over: stay conservative
    const [hh, mm] = close.split(":");
    const closeMinutes = Number(hh) * 60 + Number(mm);
    return localMinutesOfDay(nowMs, tz) < closeMinutes + FORMING_MARGIN_MS / 60_000;
  }

  const completed =
    lastBarMs < period.start ||
    (meta.regularMarketTime !== null && meta.regularMarketTime >= period.end);
  if (!completed) return true;
  // The bar belongs to the session `period` describes only when it is not older than period.start.
  if (lastBarMs >= period.start && lastDay === today && nowMs < period.end + FORMING_MARGIN_MS)
    return true;
  return false;
}

interface Row {
  day: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

function isNum(v: number | null): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface SeriesStats {
  ohlcInconsistent: number;
  jumpAnomalies: number;
  missingSessionRatio: number;
  suspect: boolean;
}

/** Quality statistics of a cleaned series (also recomputed over the merged series after an incremental update). */
export function seriesStats(series: Series): SeriesStats {
  let ohlcInconsistent = 0;
  let jumpAnomalies = 0;
  for (let i = 0; i < series.close.length; i++) {
    const c = series.close[i] as number;
    const h = series.high[i] as number;
    const l = series.low[i] as number;
    if (
      c > h + OHLC_TOLERANCE * Math.abs(h) ||
      c < l - OHLC_TOLERANCE * Math.abs(l) ||
      l > h + OHLC_TOLERANCE * Math.abs(h)
    ) {
      ohlcInconsistent++;
    }
    if (i > 0) {
      const prev = series.close[i - 1] as number;
      if (Math.abs(c / prev - 1) > JUMP_THRESHOLD) jumpAnomalies++;
    }
  }
  let missingSessionRatio = 0;
  if (series.dates.length > 0) {
    const first = series.dates[0] as number;
    const lastDay = series.dates[series.dates.length - 1] as number;
    const expected = expectedWeekdays(first, lastDay, WEEKDAYS);
    missingSessionRatio = expected > 0 ? Math.max(0, 1 - series.dates.length / expected) : 0;
  }
  return {
    ohlcInconsistent,
    jumpAnomalies,
    missingSessionRatio,
    suspect: jumpAnomalies >= SUSPECT_JUMPS || missingSessionRatio > SUSPECT_MISSING_RATIO,
  };
}

export function cleanBars(
  raw: RawBar[],
  meta: ChartMeta,
  nowMs: number,
): { series: Series; report: CleanReport } {
  const tz = meta.exchangeTimezoneName;
  let droppedNullClose = 0;
  let droppedNullHighLow = 0;
  let droppedNonPositive = 0;
  const rows: Row[] = [];

  for (const bar of raw) {
    // 2. null / NaN / non-finite close, high or low is missing data, never a trading day
    if (!isNum(bar.close)) {
      droppedNullClose++;
      continue;
    }
    if (!isNum(bar.high) || !isNum(bar.low)) {
      droppedNullHighLow++;
      continue;
    }
    // 3. non-positive close
    if (bar.close <= 0) {
      droppedNonPositive++;
      continue;
    }
    rows.push({
      day: sessionDay(bar.time, tz), // 1. exchange-local session day, never the UTC date
      open: isNum(bar.open) ? bar.open : bar.close, // open is not used by the indicator; fall back to close
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: isNum(bar.volume) ? bar.volume : 0,
      time: bar.time,
    });
  }

  // 4. sort by session day (stable), de-duplicate by day keeping the last occurrence
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => a.r.day - b.r.day || a.i - b.i);
  const kept: Row[] = [];
  let droppedDuplicates = 0;
  for (const { r } of indexed) {
    const prev = kept[kept.length - 1];
    if (prev !== undefined && prev.day === r.day) {
      kept[kept.length - 1] = r;
      droppedDuplicates++;
    } else {
      kept.push(r);
    }
  }

  // 5. forming-bar rule on the last remaining bar
  let droppedForming = false;
  const last = kept[kept.length - 1];
  if (last !== undefined && isFormingLastBar(last.time, meta, nowMs)) {
    kept.pop();
    droppedForming = true;
  }

  const series: Series = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const r of kept) {
    series.dates.push(r.day);
    series.open.push(r.open);
    series.high.push(r.high);
    series.low.push(r.low);
    series.close.push(r.close);
    series.volume.push(r.volume);
  }

  // 6. report
  const stats = seriesStats(series);
  const report: CleanReport = {
    inputBars: raw.length,
    keptBars: series.dates.length,
    droppedNullClose,
    droppedNullHighLow,
    droppedNonPositive,
    droppedDuplicates,
    droppedForming,
    ...stats,
  };
  return { series, report };
}

/** The last n bars (a copy). */
export function takeLatest(series: Series, n: number): Series {
  const start = Math.max(0, series.dates.length - Math.max(0, n));
  return {
    dates: series.dates.slice(start),
    open: series.open.slice(start),
    high: series.high.slice(start),
    low: series.low.slice(start),
    close: series.close.slice(start),
    volume: series.volume.slice(start),
  };
}

/**
 * Merges a freshly fetched tail into the stored series (union by session day, fresh wins).
 * adjustmentDrift is true when any overlapping close differs by more than 1e-4 relative, when the response carried a split newer
 * than the stored series' last full refresh (opts.newerSplit), or when nothing overlaps so adjustment cannot be proven.
 * On drift NO series is returned (a merge would combine pre- and post-split scales); the caller schedules a full backfill instead.
 */
export type MergeDriftReason = "overlap_mismatch" | "newer_split" | "no_overlap";
export type MergeResult =
  | { adjustmentDrift: false; series: Series; overlapBars: number; maxRelDiff: number }
  | { adjustmentDrift: true; overlapBars: number; maxRelDiff: number; reason: MergeDriftReason };

export function mergeIncremental(
  stored: Series,
  fresh: Series,
  opts: { newerSplit?: boolean } = {},
): MergeResult {
  const storedIndex = new Map<number, number>();
  stored.dates.forEach((d, i) => {
    storedIndex.set(d, i);
  });
  let overlapBars = 0;
  let maxRelDiff = 0;
  fresh.dates.forEach((d, i) => {
    const j = storedIndex.get(d);
    if (j === undefined) return;
    overlapBars++;
    const a = stored.close[j] as number;
    const b = fresh.close[i] as number;
    const rel = Math.abs(b - a) / Math.abs(a);
    if (rel > maxRelDiff) maxRelDiff = rel;
  });

  const cannotVerify = stored.dates.length > 0 && fresh.dates.length > 0 && overlapBars === 0;
  if (opts.newerSplit === true)
    return { adjustmentDrift: true, overlapBars, maxRelDiff, reason: "newer_split" };
  if (maxRelDiff > ADJUSTMENT_DRIFT_TOLERANCE)
    return { adjustmentDrift: true, overlapBars, maxRelDiff, reason: "overlap_mismatch" };
  if (cannotVerify) return { adjustmentDrift: true, overlapBars, maxRelDiff, reason: "no_overlap" };

  const byDay = new Map<number, number[]>();
  const put = (s: Series, i: number) =>
    byDay.set(s.dates[i] as number, [
      s.open[i] as number,
      s.high[i] as number,
      s.low[i] as number,
      s.close[i] as number,
      s.volume[i] as number,
    ]);
  for (let i = 0; i < stored.dates.length; i++) put(stored, i);
  for (let i = 0; i < fresh.dates.length; i++) put(fresh, i);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const series: Series = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const d of days) {
    const v = byDay.get(d) as number[];
    series.dates.push(d);
    series.open.push(v[0] as number);
    series.high.push(v[1] as number);
    series.low.push(v[2] as number);
    series.close.push(v[3] as number);
    series.volume.push(v[4] as number);
  }

  return { adjustmentDrift: false, series, overlapBars, maxRelDiff };
}
