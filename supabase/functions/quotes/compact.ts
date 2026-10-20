/**
 * Structural view of a provider bar. P1's core RawBar must be mapped onto this in provider.ts;
 * dateMs is the bar's timestamp in epoch milliseconds.
 */
export interface BarLike {
  dateMs: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Calendar day (days since 1970-01-01) of an instant in the exchange time zone. */
export function dayNumber(ms: number, timeZone: string | null): number {
  const tz = timeZone ?? "UTC";
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    fmtCache.set(tz, fmt);
  }
  return Math.floor(Date.parse(`${fmt.format(ms)}T00:00:00Z`) / 86_400_000);
}

const isNum = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);

/** Compact parallel arrays like `price_series`: valid bars only, ascending, unique days, no forming bar. */
export function toCompactBars(
  bars: readonly BarLike[],
  marketState: string | null,
  timeZone: string | null,
) {
  const rows = bars
    .filter((b) => isNum(b.open) && isNum(b.high) && isNum(b.low) && isNum(b.close))
    .map((b) => ({
      d: dayNumber(b.dateMs, timeZone),
      o: b.open as number,
      h: b.high as number,
      l: b.low as number,
      c: b.close as number,
      v: isNum(b.volume) ? b.volume : 0,
    }))
    .sort((a, b) => a.d - b.d);
  const unique = rows.filter((r, i) => i === 0 || r.d !== (rows[i - 1] as { d: number }).d);
  const kept = marketState === "REGULAR" ? unique.slice(0, -1) : unique;
  return {
    bar_dates: kept.map((r) => r.d),
    open: kept.map((r) => r.o),
    high: kept.map((r) => r.h),
    low: kept.map((r) => r.l),
    close: kept.map((r) => r.c),
    volume: kept.map((r) => r.v),
  };
}
