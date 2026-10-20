import { DEFAULT_SETTINGS, valueAt } from "@core/indicator.ts";
import { describe, expect, it } from "vitest";
import { makeBars } from "@/test/bars";
import {
  barsFromArrays,
  channelValuesAt,
  computeChannelData,
  dayToIso,
  defaultViewRange,
  EXTENSION_BARS,
  LINE_KEYS,
  lastNBars,
  nextWeekdays,
  RIGHT_MARGIN_BARS,
  rangeToLogical,
  subtractMonths,
  whitespaceTimes,
} from "./chart-data";

const at = <T>(a: readonly T[], i: number): T => {
  const v = a[i];
  if (v === undefined) throw new Error(`missing index ${i}`);
  return v;
};

describe("constants", () => {
  it("right margin 12 bars, extension 126 bars", () => {
    expect(RIGHT_MARGIN_BARS).toBe(12);
    expect(EXTENSION_BARS).toBe(126);
  });
});

describe("dates", () => {
  it("dayToIso converts days since 1970-01-01", () => {
    expect(dayToIso(0)).toBe("1970-01-01");
    expect(dayToIso(1)).toBe("1970-01-02");
    expect(Date.parse(`${dayToIso(20000)}T00:00:00Z`) / 86_400_000).toBe(20000);
  });
  it("barsFromArrays zips the parallel arrays", () => {
    const bars = barsFromArrays({
      bar_dates: [0, 1],
      open: [1, 2],
      high: [3, 4],
      low: [0, 1],
      close: [2, 3],
      volume: [10, 20],
    });
    expect(bars).toEqual([
      { time: "1970-01-01", open: 1, high: 3, low: 0, close: 2, volume: 10 },
      { time: "1970-01-02", open: 2, high: 4, low: 1, close: 3, volume: 20 },
    ]);
  });
  it("nextWeekdays skips weekends", () => {
    expect(nextWeekdays("2026-10-16", 3)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]); // Fri -> Mon..Wed
    expect(nextWeekdays("2026-10-16", 0)).toEqual([]);
  });
  it("the 126th weekday after Friday 2026-10-16 is Monday 2027-04-12", () => {
    const w = nextWeekdays("2026-10-16", 126);
    expect(w).toHaveLength(126);
    expect(at(w, 124)).toBe("2027-04-09");
    expect(at(w, 125)).toBe("2027-04-12");
  });
  it("subtractMonths clamps to the end of a shorter month", () => {
    expect(subtractMonths("2026-10-14", 1)).toBe("2026-09-14");
    expect(subtractMonths("2026-03-31", 1)).toBe("2026-02-28");
    expect(subtractMonths("2024-02-29", 12)).toBe("2023-02-28");
    expect(subtractMonths("2026-01-15", 6)).toBe("2025-07-15");
  });
  it("lastNBars returns the newest n without mutating", () => {
    const b = makeBars(10);
    expect(lastNBars(b, 3)).toEqual(b.slice(7));
    expect(lastNBars(b, 50)).toEqual(b);
  });
});

describe("computeChannelData: geometry on a hand-computable series", () => {
  // close_i = 10 + i for 30 weekday bars; window length 20 -> window = bars 10..29.
  // Perfect line: stPrice = 20 (bar 10), endPrice = 39 (bar 29), stdDev ~ 0, so every offset ~ 0.
  // Base/set-1 drawn slope = 19/19 = 1  -> value at lastIndex + 126 = 39 + 126 = 165.
  // Set-2 drawn slope = (39 - 20) / (20 - 2) = 19/18 -> 39 + 126 * 19/18 = 39 + 133 = 172.
  const bars = makeBars(30, "2026-08-03", (i) => 10 + i);
  const settings = { ...DEFAULT_SETTINGS, length: 20 };
  const result = computeChannelData(bars, settings);

  it("is ok with five lines in a stable order and titles", () => {
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.lines.map((l) => l.key)).toEqual([...LINE_KEYS]);
    expect(result.lines.map((l) => l.title)).toEqual(["+2", "+1", "Base", "-3", "-4"]);
    expect(result.channel.lastIndex).toBe(19);
  });

  it("set-1 and base lines: left point at window start, right point at the last bar, extension at +126", () => {
    if (result.status !== "ok") throw new Error("expected ok");
    const ext = at(nextWeekdays(at(bars, 29).time, 126), 125);
    for (const key of ["base", "upper1", "lower1"] as const) {
      const line = at(
        result.lines.filter((l) => l.key === key),
        0,
      );
      expect(line.points.map((p) => p.time)).toEqual([at(bars, 10).time, at(bars, 29).time, ext]);
      expect(at(line.points, 0).value).toBeCloseTo(20, 6);
      expect(at(line.points, 1).value).toBeCloseTo(39, 6);
      expect(at(line.points, 2).value).toBeCloseTo(165, 6);
    }
  });

  it("set-2 lines start one bar later with the stPrice-based y1 and extend with their OWN steeper slope", () => {
    if (result.status !== "ok") throw new Error("expected ok");
    const ext = at(nextWeekdays(at(bars, 29).time, 126), 125);
    for (const key of ["upper2", "lower2"] as const) {
      const line = at(
        result.lines.filter((l) => l.key === key),
        0,
      );
      expect(line.points.map((p) => p.time)).toEqual([at(bars, 11).time, at(bars, 29).time, ext]);
      expect(at(line.points, 0).value).toBeCloseTo(20, 6);
      expect(at(line.points, 1).value).toBeCloseTo(39, 6);
      expect(at(line.points, 2).value).toBeCloseTo(172, 6);
    }
    expect(result.channel.upper2.slopePerBar).toBeCloseTo(19 / 18, 9);
  });

  it("extension values equal valueAt of the same segment", () => {
    if (result.status !== "ok") throw new Error("expected ok");
    const idx = result.channel.lastIndex + EXTENSION_BARS;
    const byKey = Object.fromEntries(result.lines.map((l) => [l.key, l]));
    expect(at(byKey.upper2?.points ?? [], 2).value).toBeCloseTo(
      valueAt(result.channel.upper2, idx),
      9,
    );
    expect(at(byKey.base?.points ?? [], 2).value).toBeCloseTo(valueAt(result.channel.base, idx), 9);
    expect(at(byKey.lower2?.points ?? [], 2).value).toBeCloseTo(
      valueAt(result.channel.lower2, idx),
      9,
    );
  });

  it("all line points have strictly increasing times", () => {
    if (result.status !== "ok") throw new Error("expected ok");
    for (const l of result.lines) {
      const times = l.points.map((p) => p.time);
      expect([...times].sort()).toEqual(times);
      expect(new Set(times).size).toBe(times.length);
    }
  });

  it("whitespaceTimes gives the 126 future weekdays", () => {
    const w = whitespaceTimes(bars);
    expect(w).toHaveLength(126);
    expect(at(w, 0)).toBe(nextWeekdays(at(bars, 29).time, 1)[0]);
  });
});

describe("computeChannelData: window and insufficient data", () => {
  it("fewer than 2,500 bars gives no lines and the counts for the notice", () => {
    expect(computeChannelData(makeBars(100))).toEqual({
      status: "insufficient",
      have: 100,
      need: 2500,
    });
  });
  it("exactly 2,500 bars computes the channel", () => {
    const r = computeChannelData(makeBars(2500));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.lines).toHaveLength(5);
  });
  it("with more bars only the latest 2,500 form the window", () => {
    const bars = makeBars(2600);
    const r = computeChannelData(bars);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.channel.lastIndex).toBe(2499);
    const base = at(
      r.lines.filter((l) => l.key === "base"),
      0,
    );
    expect(at(base.points, 0).time).toBe(at(bars, 100).time);
    expect(at(base.points, 1).time).toBe(at(bars, 2599).time);
  });
  it("invalid settings are reported, not thrown", () => {
    const r = computeChannelData(makeBars(50), { ...DEFAULT_SETTINGS, length: 2 });
    expect(r.status === "insufficient" || r.status === "invalid").toBe(true);
  });
});

describe("rangeToLogical", () => {
  const days = [
    "2025-12-30",
    "2025-12-31",
    "2026-01-02",
    "2026-01-05",
    "2026-02-02",
    "2026-03-02",
    "2026-04-01",
    "2026-05-04",
    "2026-06-01",
    "2026-07-01",
    "2026-08-03",
    "2026-09-01",
    "2026-10-01",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
  ].map((time) => ({ time }));
  // lastIndex = 15, so every range ends at 15 + 12 = 27.
  const r = (k: Parameters<typeof rangeToLogical>[0]) => rangeToLogical(k, days);

  it("every range ends at lastIndex + 12", () => {
    for (const k of ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const) {
      expect(r(k)?.to).toBe(27);
    }
  });
  it("1D is the last 2 bars and 5D the last 5 bars", () => {
    expect(r("1D")?.from).toBe(14);
    expect(r("5D")?.from).toBe(11);
  });
  it("1M, 6M, 1Y, 5Y start at the first bar on or after the calendar offset", () => {
    expect(r("1M")?.from).toBe(12); // 2026-09-14 -> 2026-10-01
    expect(r("6M")?.from).toBe(7); // 2026-04-14 -> 2026-05-04
    expect(r("1Y")?.from).toBe(0); // 2025-10-14 -> first bar 2025-12-30
    expect(r("5Y")?.from).toBe(0);
  });
  it("YTD starts at the first bar on or after 1 January of the last bar's year", () => {
    expect(r("YTD")?.from).toBe(2); // 2026-01-02
  });
  it("MAX starts at the first bar", () => {
    expect(r("MAX")?.from).toBe(0);
  });
  it("a single bar still yields a valid range and an empty series yields null", () => {
    expect(rangeToLogical("1D", [{ time: "2026-10-14" }])).toEqual({ from: 0, to: 12 });
    expect(rangeToLogical("1D", [])).toBeNull();
  });
  it("defaultViewRange shows about ten years ending at the last bar plus the margin", () => {
    expect(defaultViewRange(days)).toEqual({ from: 0, to: 27 });
    const long = makeBars(3000);
    const v = defaultViewRange(long);
    expect(v?.to).toBe(2999 + 12);
    expect(v?.from).toBeGreaterThan(380); // 3000 weekdays are ~11.5 years: ten years back starts near index 390
    expect(v?.from).toBeLessThan(400);
  });
});

describe("computeChannelData: noisy series", () => {
  const noisy = makeBars(60, "2026-06-01", (i) => 100 + i * 0.5 + Math.sin(i) * 4);
  const sigma = { ...DEFAULT_SETTINGS, length: 50 };

  it("has a non-zero deviation and orders upper1 > base > lower1 at the last bar, equal to channel.end", () => {
    const r = computeChannelData(noisy, sigma);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.channel.stdDev).toBeGreaterThan(0);
    const last = (key: string) => {
      const line = at(
        r.lines.filter((l) => l.key === key),
        0,
      );
      return at(line.points, 1).value;
    };
    expect(last("upper1")).toBeGreaterThan(last("base"));
    expect(last("base")).toBeGreaterThan(last("lower1"));
    for (const k of LINE_KEYS) expect(last(k)).toBeCloseTo(r.channel.end[k], 9);
  });

  it("max-deviation mode (all four flags off) still gives an ordered channel matching channel.end", () => {
    const r = computeChannelData(noisy, {
      ...sigma,
      upper1Mode: false,
      upper2Mode: false,
      lower1Mode: false,
      lower2Mode: false,
    });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.channel.upDev).toBeGreaterThan(0);
    expect(r.channel.end.upper1).toBeGreaterThan(r.channel.end.base);
    expect(r.channel.end.base).toBeGreaterThan(r.channel.end.lower1);
    for (const line of r.lines) {
      expect(at(line.points, 1).value).toBeCloseTo(r.channel.end[line.key], 9);
    }
  });

  it("channelValuesAt equals valueAt per segment, from each x1 up to +126 only", () => {
    const r = computeChannelData(noisy, sigma); // window = bars 10..59 of 60
    if (r.status !== "ok") throw new Error("expected ok");
    const mid = channelValuesAt(r, 60, 35); // window index 25
    expect(mid.base).toBeCloseTo(valueAt(r.channel.base, 25), 9);
    expect(mid.lower2).toBeCloseTo(valueAt(r.channel.lower2, 25), 9);
    const first = channelValuesAt(r, 60, 10); // window index 0: set 2 starts one bar later
    expect(first.base).toBeDefined();
    expect(first.upper2).toBeUndefined();
    expect(channelValuesAt(r, 60, 5)).toEqual({}); // before the window
    expect(channelValuesAt(r, 60, 59 + 126).base).toBeCloseTo(valueAt(r.channel.base, 49 + 126), 9);
    expect(channelValuesAt(r, 60, 59 + 127)).toEqual({});
    expect(channelValuesAt({ status: "insufficient", have: 1, need: 2 }, 1, 0)).toEqual({});
  });
});
