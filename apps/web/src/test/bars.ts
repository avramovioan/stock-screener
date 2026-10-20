import type { Bar } from "@/features/quotes/chart-data";
import { nextWeekdays } from "@/features/quotes/chart-data";
import type { PriceSeries } from "@/features/screening/types";

/** `n` consecutive weekday bars starting at `start` (a weekday). Default close is a gentle wave. */
export function makeBars(
  n: number,
  start = "2016-01-04",
  closeAt: (i: number) => number = (i) => 100 + i * 0.01 + Math.sin(i / 15) * 3,
): Bar[] {
  const times = [start, ...nextWeekdays(start, n - 1)];
  return times.map((time, i) => {
    const close = closeAt(i);
    return { time, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}

export function seriesFromBars(bars: Bar[], securityId: string): PriceSeries {
  const last = bars[bars.length - 1] as Bar;
  return {
    security_id: securityId,
    bar_dates: bars.map((b) => Date.parse(`${b.time}T00:00:00Z`) / 86_400_000),
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
    bar_count: bars.length,
    first_bar_date: (bars[0] as Bar).time,
    last_bar_date: last.time,
    last_session_date: last.time,
    last_close: last.close,
    prev_close: null,
    freshness: "fresh",
  };
}
