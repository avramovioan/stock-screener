import { assertEquals } from "@std/assert";
import { type BarLike, dayNumber, toCompactBars } from "./compact.ts";

const DAY = 86_400_000;
const bar = (dateMs: number, c: number | null, over: Partial<BarLike> = {}): BarLike => ({
  dateMs,
  open: c,
  high: c === null ? null : c + 1,
  low: c === null ? null : c - 1,
  close: c,
  volume: 100,
  ...over,
});

Deno.test("dayNumber uses the exchange time zone, not UTC", () => {
  // 2026-10-14T15:00:00Z is 00:00 on 2026-10-15 in Tokyo.
  const ms = Date.UTC(2026, 9, 14, 15, 0, 0);
  assertEquals(dayNumber(ms, "Asia/Tokyo"), Date.UTC(2026, 9, 15) / DAY);
  assertEquals(dayNumber(ms, "UTC"), Date.UTC(2026, 9, 14) / DAY);
  assertEquals(dayNumber(ms, null), Date.UTC(2026, 9, 14) / DAY);
});

Deno.test("toCompactBars drops null bars, sorts, de-duplicates and fills null volume with 0", () => {
  const d = (n: number) => Date.UTC(2026, 9, n, 12);
  const out = toCompactBars(
    [
      bar(d(14), 11),
      bar(d(13), 10),
      bar(d(15), null),
      bar(d(13), 99),
      bar(d(12), 9, { volume: null }),
    ],
    "CLOSED",
    "UTC",
  );
  assertEquals(
    out.bar_dates,
    [d(12), d(13), d(14)].map((ms) => Math.floor(ms / DAY)),
  );
  assertEquals(out.close, [9, 10, 11]);
  assertEquals(out.volume, [0, 100, 100]);
  assertEquals(out.high, [10, 11, 12]);
});

Deno.test("toCompactBars drops the forming bar while the market is REGULAR", () => {
  const d = (n: number) => Date.UTC(2026, 9, n, 12);
  const bars = [bar(d(13), 10), bar(d(14), 11)];
  assertEquals(toCompactBars(bars, "REGULAR", "UTC").close, [10]);
  assertEquals(toCompactBars(bars, "CLOSED", "UTC").close, [10, 11]);
  assertEquals(toCompactBars(bars, null, "UTC").close, [10, 11]);
});
