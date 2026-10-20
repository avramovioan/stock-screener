import type { Series } from "../../_shared/core/bars.ts";
import { isoDate } from "../../_shared/core/calendar.ts";

/** Columns of price_series that the pipeline reads. Arrays come back from PostgREST as JSON arrays of numbers. */
export interface PriceSeriesRow {
  security_id: string;
  bar_dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  bar_count: number;
  last_session_date: string;
  last_full_refresh_at: string;
  completeness: Record<string, unknown>;
}

export function seriesFromRow(
  row: Pick<PriceSeriesRow, "bar_dates" | "open" | "high" | "low" | "close" | "volume">,
): Series {
  return {
    dates: [...row.bar_dates],
    open: [...row.open],
    high: [...row.high],
    low: [...row.low],
    close: [...row.close],
    volume: [...row.volume],
  };
}

/** The upsert payload for price_series. Dates must be strictly ascending (the cleaner guarantees it). */
export function rowFromSeries(a: {
  securityId: string;
  series: Series;
  completeness: Record<string, unknown>;
  freshness: "fresh" | "stale" | "unavailable";
  nowIso: string;
  lastFullRefreshIso: string;
}): Record<string, unknown> {
  const s = a.series;
  const n = s.dates.length;
  if (n === 0) throw new RangeError("an empty series is never stored");
  return {
    security_id: a.securityId,
    bar_dates: s.dates,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume.map((v) => Math.round(v)),
    adjustment_policy: "yahoo_split_adjusted_close_v1",
    provider: "yahoo",
    bar_count: n,
    first_bar_date: isoDate(s.dates[0] as number),
    last_bar_date: isoDate(s.dates[n - 1] as number),
    last_session_date: isoDate(s.dates[n - 1] as number),
    last_close: s.close[n - 1],
    prev_close: n > 1 ? s.close[n - 2] : null,
    retrieved_at: a.nowIso,
    last_full_refresh_at: a.lastFullRefreshIso,
    completeness: a.completeness,
    freshness: a.freshness,
  };
}

/** SHA-256 (hex) of the window the indicator used: reproducibility evidence stored as scan_security_results.bars_hash. */
export async function hashWindow(
  series: { close: ArrayLike<number>; high: ArrayLike<number>; low: ArrayLike<number> },
  length: number,
): Promise<string> {
  const n = series.close.length;
  const from = Math.max(0, n - length);
  const parts: string[] = [];
  for (let i = from; i < n; i++)
    parts.push(`${series.close[i]},${series.high[i]},${series.low[i]}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join(";")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True when two series hold the same bars (dates and every OHLCV value). PostgREST returns float8 with 15 significant digits, so a stored
 * price differs from the freshly fetched one in the 16th digit: prices compare with a 1e-12 relative tolerance, dates and volumes exactly.
 */
export function sameSeries(a: Series, b: Series): boolean {
  if (a.dates.length !== b.dates.length) return false;
  const eq = (x: number[], y: number[]) => x.every((v, i) => v === y[i]);
  const near = (x: number[], y: number[]) =>
    x.every((v, i) => {
      const w = y[i] as number;
      return Math.abs(v - w) <= 1e-12 * Math.max(Math.abs(v), Math.abs(w));
    });
  return (
    eq(a.dates, b.dates) &&
    near(a.close, b.close) &&
    near(a.open, b.open) &&
    near(a.high, b.high) &&
    near(a.low, b.low) &&
    eq(a.volume, b.volume)
  );
}
