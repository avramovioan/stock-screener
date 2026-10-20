import { describe, expect, it } from "vitest";
import {
  type ChartMeta,
  cleanBars,
  isFormingLastBar,
  mergeIncremental,
  type RawBar,
  type Series,
  seriesStats,
  sessionDay,
  takeLatest,
} from "./bars.ts";
import { dayNumber, isoDate } from "./calendar.ts";

const utc = (iso: string) => Date.parse(iso);
const day = (iso: string) =>
  dayNumber(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
const iso = (n: number) => isoDate(n);

function bar(time: string, close: number | null, extra: Partial<RawBar> = {}): RawBar {
  return {
    time: utc(time),
    open: close === null ? null : close - 0.5,
    high: close === null ? null : close + 1,
    low: close === null ? null : close - 1,
    close,
    volume: close === null ? null : 1000,
    ...extra,
  };
}

/** Weekday bars at a fixed session-open time, oldest first. */
function weekdayBars(fromIso: string, count: number, hhmm: string, start = 100): RawBar[] {
  const out: RawBar[] = [];
  let n = day(fromIso);
  let close = start;
  while (out.length < count) {
    const wd = ((n + 3) % 7) + 1;
    if (wd <= 5) {
      out.push(bar(`${iso(n)}T${hhmm}:00Z`, close));
      close += 0.1;
    }
    n++;
  }
  return out;
}

// Observed states of spike 3.2 (run at 2026-10-15 07:42Z)
const NOW_SPIKE = utc("2026-10-15T07:42:00Z");
const sapMeta: ChartMeta = {
  exchangeTimezoneName: "Europe/Berlin",
  regularMarketTime: utc("2026-10-15T07:27:36Z"),
  currentTradingPeriod: { start: utc("2026-10-15T07:00:00Z"), end: utc("2026-10-15T15:30:00Z") },
  marketState: "REGULAR",
};

describe("sessionDay", () => {
  it("uses the exchange-local date, not the UTC date", () => {
    expect(iso(sessionDay(utc("2026-10-14T13:30:00Z"), "America/New_York"))).toBe("2026-10-14");
    expect(iso(sessionDay(utc("2026-10-15T01:30:00Z"), "Asia/Hong_Kong"))).toBe("2026-10-15");
    expect(iso(sessionDay(utc("2026-10-14T23:00:00Z"), "Australia/Sydney"))).toBe("2026-10-15");
  });
});

describe("isFormingLastBar: the five observed states of spike 3.2", () => {
  it("SAP.DE (bar == period.start, regularMarketTime < end, REGULAR) is forming", () => {
    expect(isFormingLastBar(utc("2026-10-15T07:00:00Z"), sapMeta, NOW_SPIKE)).toBe(true);
  });

  it("2222.SR forming", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Asia/Riyadh",
      regularMarketTime: utc("2026-10-15T07:27:40Z"),
      currentTradingPeriod: {
        start: utc("2026-10-15T07:00:00Z"),
        end: utc("2026-10-15T12:00:00Z"),
      },
      marketState: "REGULAR",
    };
    expect(isFormingLastBar(utc("2026-10-15T07:00:00Z"), meta, NOW_SPIKE)).toBe(true);
  });

  it("RELIANCE.NS forming even without a marketState", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Asia/Kolkata",
      regularMarketTime: utc("2026-10-15T07:42:40Z"),
      currentTradingPeriod: {
        start: utc("2026-10-15T03:45:00Z"),
        end: utc("2026-10-15T10:00:00Z"),
      },
    };
    expect(isFormingLastBar(utc("2026-10-15T03:45:00Z"), meta, NOW_SPIKE)).toBe(true);
  });

  it("7203.T (regularMarketTime >= period.end, POSTPOST) is completed once the 30-minute margin has passed", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Asia/Tokyo",
      regularMarketTime: utc("2026-10-15T06:30:00Z"),
      currentTradingPeriod: {
        start: utc("2026-10-15T00:00:00Z"),
        end: utc("2026-10-15T06:30:00Z"),
      },
      marketState: "POSTPOST",
    };
    expect(isFormingLastBar(utc("2026-10-15T00:00:00Z"), meta, NOW_SPIKE)).toBe(false);
  });

  it("AAPL / NVDA (bar older than the next session's start, PREPRE) is completed", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-14T20:00:01Z"),
      currentTradingPeriod: {
        start: utc("2026-10-15T13:30:00Z"),
        end: utc("2026-10-15T20:00:00Z"),
      },
      marketState: "PREPRE",
    };
    expect(isFormingLastBar(utc("2026-10-14T13:30:00Z"), meta, NOW_SPIKE)).toBe(false);
  });
});

describe("isFormingLastBar: margins, states and fallbacks", () => {
  const tokyo = (rmt: string): ChartMeta => ({
    exchangeTimezoneName: "Asia/Tokyo",
    regularMarketTime: utc(rmt),
    currentTradingPeriod: { start: utc("2026-10-15T00:00:00Z"), end: utc("2026-10-15T06:30:00Z") },
    marketState: "POST",
  });

  it("29 minutes after the session end the bar is still treated as forming (safety margin)", () => {
    expect(
      isFormingLastBar(
        utc("2026-10-15T00:00:00Z"),
        tokyo("2026-10-15T06:30:00Z"),
        utc("2026-10-15T06:59:00Z"),
      ),
    ).toBe(true);
  });
  it("31 minutes after the session end the bar is completed", () => {
    expect(
      isFormingLastBar(
        utc("2026-10-15T00:00:00Z"),
        tokyo("2026-10-15T06:30:00Z"),
        utc("2026-10-15T07:01:00Z"),
      ),
    ).toBe(false);
  });

  it("REGULAR with a bar of an earlier local day does not drop a completed bar", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-15T13:45:00Z"),
      currentTradingPeriod: {
        start: utc("2026-10-15T13:30:00Z"),
        end: utc("2026-10-15T20:00:00Z"),
      },
      marketState: "REGULAR",
    };
    // last bar is yesterday's completed session (today's bar not created yet)
    expect(isFormingLastBar(utc("2026-10-14T13:30:00Z"), meta, utc("2026-10-15T13:50:00Z"))).toBe(
      false,
    );
    // last bar is today's in-progress session
    expect(isFormingLastBar(utc("2026-10-15T13:30:00Z"), meta, utc("2026-10-15T13:50:00Z"))).toBe(
      true,
    );
  });

  it("weekend: Friday bar on a Saturday scan is completed", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-16T20:00:00Z"),
      currentTradingPeriod: {
        start: utc("2026-10-19T13:30:00Z"),
        end: utc("2026-10-19T20:00:00Z"),
      },
      marketState: "CLOSED",
    };
    expect(isFormingLastBar(utc("2026-10-16T13:30:00Z"), meta, utc("2026-10-17T07:00:00Z"))).toBe(
      false,
    );
  });

  it("without currentTradingPeriod: today's bar before close + 30 min is forming, after it is not", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Europe/Berlin",
      regularMarketTime: null,
      currentTradingPeriod: null,
      sessionCloseLocal: "17:30",
    };
    const bar0 = utc("2026-10-15T07:00:00Z");
    expect(isFormingLastBar(bar0, meta, utc("2026-10-15T10:00:00Z"))).toBe(true); // 12:00 local
    expect(isFormingLastBar(bar0, meta, utc("2026-10-15T15:50:00Z"))).toBe(true); // 17:50 local, inside the margin
    expect(isFormingLastBar(bar0, meta, utc("2026-10-15T16:10:00Z"))).toBe(false); // 18:10 local
    expect(isFormingLastBar(utc("2026-10-14T07:00:00Z"), meta, utc("2026-10-15T10:00:00Z"))).toBe(
      false,
    );
  });

  it("without currentTradingPeriod and without a known close: today's bar is conservatively forming", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Europe/Berlin",
      regularMarketTime: null,
      currentTradingPeriod: null,
    };
    expect(isFormingLastBar(utc("2026-10-15T07:00:00Z"), meta, utc("2026-10-15T20:00:00Z"))).toBe(
      true,
    );
  });
});

describe("cleanBars", () => {
  it("never lets a forming bar through as a completed close (SAP.DE: null 2026-10-14 plus forming 2026-10-15)", () => {
    const hist = weekdayBars("2026-10-05", 7, "07:00"); // 10-05 .. 10-13
    const raw = [...hist, bar("2026-10-14T07:00:00Z", null), bar("2026-10-15T07:00:00Z", 199.62)];
    const { series, report } = cleanBars(raw, sapMeta, NOW_SPIKE);
    expect(report.droppedForming).toBe(true);
    expect(report.droppedNullClose).toBe(1);
    expect(iso(series.dates[series.dates.length - 1] as number)).toBe("2026-10-13");
    expect(series.close).not.toContain(199.62);
    expect(report.inputBars).toBe(9);
    expect(report.keptBars).toBe(7);
  });

  it("keeps the last bar when it is completed (AAPL)", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-14T20:00:01Z"),
      currentTradingPeriod: {
        start: utc("2026-10-15T13:30:00Z"),
        end: utc("2026-10-15T20:00:00Z"),
      },
      marketState: "PREPRE",
    };
    const raw = weekdayBars("2026-10-07", 6, "13:30");
    const { series, report } = cleanBars(raw, meta, NOW_SPIKE);
    expect(report.droppedForming).toBe(false);
    expect(series.dates).toHaveLength(6);
    expect(iso(series.dates[5] as number)).toBe("2026-10-14");
  });

  it("converts NVDA bars across the 10:1 split days to session days and sees no jump (close is split-adjusted)", () => {
    const raw: RawBar[] = [
      bar("2024-06-03T13:30:00Z", 115),
      bar("2024-06-04T13:30:00Z", 116.43699645996094),
      bar("2024-06-05T13:30:00Z", 122.44000244140625),
      bar("2024-06-06T13:30:00Z", 120.99800109863281),
      bar("2024-06-07T13:30:00Z", 120.88800048828125),
      bar("2024-06-10T13:30:00Z", 121.79000091552734),
    ];
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2024-06-10T20:00:00Z"),
      currentTradingPeriod: {
        start: utc("2024-06-11T13:30:00Z"),
        end: utc("2024-06-11T20:00:00Z"),
      },
      marketState: "CLOSED",
    };
    const { series, report } = cleanBars(raw, meta, utc("2024-06-11T05:00:00Z"));
    expect(series.dates.map(iso)).toEqual([
      "2024-06-03",
      "2024-06-04",
      "2024-06-05",
      "2024-06-06",
      "2024-06-07",
      "2024-06-10",
    ]);
    expect(report.jumpAnomalies).toBe(0);
    expect(report.suspect).toBe(false);
  });

  it("drops null, NaN, infinite and non-positive rows and counts each reason", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "UTC",
      regularMarketTime: null,
      currentTradingPeriod: {
        start: utc("2026-10-20T00:00:00Z"),
        end: utc("2026-10-20T20:00:00Z"),
      },
    };
    const raw: RawBar[] = [
      bar("2026-10-12T00:00:00Z", 10),
      bar("2026-10-13T00:00:00Z", null),
      bar("2026-10-14T00:00:00Z", Number.NaN),
      bar("2026-10-15T00:00:00Z", 12, { high: null }),
      bar("2026-10-16T00:00:00Z", 12, { low: Number.POSITIVE_INFINITY }),
      bar("2026-10-17T00:00:00Z", 0),
      bar("2026-10-18T00:00:00Z", -3),
      bar("2026-10-19T00:00:00Z", 11),
    ];
    const { series, report } = cleanBars(raw, meta, utc("2026-10-19T12:00:00Z"));
    expect(series.close).toEqual([10, 11]);
    expect(report.droppedNullClose).toBe(2);
    expect(report.droppedNullHighLow).toBe(2);
    expect(report.droppedNonPositive).toBe(2);
  });

  it("sorts by session day and keeps the LAST occurrence of a duplicate day", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "UTC",
      regularMarketTime: null,
      currentTradingPeriod: {
        start: utc("2026-10-30T00:00:00Z"),
        end: utc("2026-10-30T20:00:00Z"),
      },
    };
    const raw: RawBar[] = [
      bar("2026-10-14T00:00:00Z", 12),
      bar("2026-10-13T00:00:00Z", 10),
      bar("2026-10-13T00:00:00Z", 11), // later occurrence wins
    ];
    const { series, report } = cleanBars(raw, meta, utc("2026-10-20T00:00:00Z"));
    expect(series.dates.map(iso)).toEqual(["2026-10-13", "2026-10-14"]);
    expect(series.close).toEqual([11, 12]);
    expect(report.droppedDuplicates).toBe(1);
  });

  it("falls back to close for a null open and 0 for a null volume", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "UTC",
      regularMarketTime: null,
      currentTradingPeriod: {
        start: utc("2026-10-30T00:00:00Z"),
        end: utc("2026-10-30T20:00:00Z"),
      },
    };
    const { series } = cleanBars(
      [bar("2026-10-13T00:00:00Z", 10, { open: null, volume: null })],
      meta,
      utc("2026-10-20T00:00:00Z"),
    );
    expect(series.open).toEqual([10]);
    expect(series.volume).toEqual([0]);
  });

  it("counts inconsistent OHLC (close outside [low, high]) but keeps the bar", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "UTC",
      regularMarketTime: null,
      currentTradingPeriod: {
        start: utc("2026-10-30T00:00:00Z"),
        end: utc("2026-10-30T20:00:00Z"),
      },
    };
    const raw = [
      bar("2026-10-13T00:00:00Z", 10, { high: 9, low: 8 }),
      bar("2026-10-14T00:00:00Z", 10),
      bar("2026-10-15T00:00:00Z", 10, { high: 10 * (1 + 5e-7), low: 9 }), // within 1e-6 relative: consistent
    ];
    const { series, report } = cleanBars(raw, meta, utc("2026-10-20T00:00:00Z"));
    expect(series.dates).toHaveLength(3);
    expect(report.ohlcInconsistent).toBe(1);
  });

  it("flags a series with three 50%+ jumps as suspect and tolerates two", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "UTC",
      regularMarketTime: null,
      currentTradingPeriod: {
        start: utc("2026-12-30T00:00:00Z"),
        end: utc("2026-12-30T20:00:00Z"),
      },
    };
    const closes = (xs: number[]) =>
      xs.map((c, i) => bar(`2026-10-${String(12 + i).padStart(2, "0")}T00:00:00Z`, c));
    const two = cleanBars(
      closes([100, 100, 200, 200, 400, 400, 400]),
      meta,
      utc("2026-11-30T00:00:00Z"),
    );
    expect(two.report.jumpAnomalies).toBe(2);
    expect(two.report.suspect).toBe(false);
    const three = cleanBars(
      closes([100, 200, 80, 200, 200, 200, 200]),
      meta,
      utc("2026-11-30T00:00:00Z"),
    );
    expect(three.report.jumpAnomalies).toBe(3);
    expect(three.report.suspect).toBe(true);
  });

  it("flags a series with more than 15% missing sessions as suspect", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "UTC",
      regularMarketTime: null,
      currentTradingPeriod: {
        start: utc("2027-12-30T00:00:00Z"),
        end: utc("2027-12-30T20:00:00Z"),
      },
    };
    const all = weekdayBars("2026-01-05", 100, "00:00");
    const gappy = all.filter((_, i) => i % 5 !== 0 && i % 5 !== 1); // drops 40%
    const { report } = cleanBars(gappy, meta, utc("2027-11-30T00:00:00Z"));
    expect(report.missingSessionRatio).toBeGreaterThan(0.15);
    expect(report.suspect).toBe(true);
    const full = cleanBars(all, meta, utc("2027-11-30T00:00:00Z"));
    expect(full.report.missingSessionRatio).toBe(0);
    expect(full.report.suspect).toBe(false);
  });

  it("handles empty input", () => {
    const { series, report } = cleanBars([], sapMeta, NOW_SPIKE);
    expect(series.dates).toEqual([]);
    expect(report.keptBars).toBe(0);
    expect(report.droppedForming).toBe(false);
    expect(report.suspect).toBe(false);
  });
});

describe("takeLatest", () => {
  const s: Series = {
    dates: [1, 2, 3, 4],
    open: [1, 2, 3, 4],
    high: [1, 2, 3, 4],
    low: [1, 2, 3, 4],
    close: [1, 2, 3, 4],
    volume: [1, 2, 3, 4],
  };
  it("returns the last n bars as a copy", () => {
    const t = takeLatest(s, 2);
    expect(t.dates).toEqual([3, 4]);
    t.close[0] = 99;
    expect(s.close[2]).toBe(3);
  });
  it("returns everything when n exceeds the length and nothing for n = 0", () => {
    expect(takeLatest(s, 10).dates).toEqual([1, 2, 3, 4]);
    expect(takeLatest(s, 0).dates).toEqual([]);
  });
});

describe("mergeIncremental", () => {
  const mk = (dates: number[], closes: number[]): Series => ({
    dates,
    open: closes.map((c) => c - 1),
    high: closes.map((c) => c + 1),
    low: closes.map((c) => c - 2),
    close: closes,
    volume: closes.map(() => 10),
  });

  const merged = (r: ReturnType<typeof mergeIncremental>) => {
    if (r.adjustmentDrift) throw new Error(`unexpected drift: ${r.reason}`);
    return r;
  };

  it("appends new bars when the overlap agrees", () => {
    const stored = mk([1, 2, 3, 4, 5], [10, 11, 12, 13, 14]);
    const fresh = mk([4, 5, 6, 7], [13, 14, 15, 16]);
    const r = merged(mergeIncremental(stored, fresh));
    expect(r.series.dates).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.series.close).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(r.overlapBars).toBe(2);
    expect(r.maxRelDiff).toBe(0);
    expect(r.adjustmentDrift).toBe(false);
  });

  it("absorbs a late correction below 1e-4 relative without drift (fresh wins)", () => {
    const stored = mk([1, 2, 3], [100, 100, 100]);
    const fresh = mk([3, 4], [100.005, 101]);
    const r = merged(mergeIncremental(stored, fresh));
    expect(r.adjustmentDrift).toBe(false);
    expect(r.series.close).toEqual([100, 100, 100.005, 101]);
    expect(r.maxRelDiff).toBeCloseTo(5e-5, 10);
  });

  it("detects a split rewriting history: stored pre-split scale vs fresh adjusted scale", () => {
    const stored = mk([1, 2, 3], [1208.88, 1217.9, 1220]);
    const fresh = mk([2, 3, 4], [121.79, 122, 123]); // 10:1 split adjusted
    const r = mergeIncremental(stored, fresh);
    expect(r.adjustmentDrift).toBe(true);
    expect("series" in r).toBe(false);
    expect(r).toMatchObject({ reason: "overlap_mismatch" });
    expect(r.maxRelDiff).toBeGreaterThan(0.8);
  });

  it("flags drift when the response carries a split newer than the last full refresh, even if the overlap agrees", () => {
    const stored = mk([1, 2, 3], [10, 11, 12]);
    const fresh = mk([2, 3, 4], [11, 12, 13]);
    const drift = mergeIncremental(stored, fresh, { newerSplit: true });
    expect(drift.adjustmentDrift).toBe(true);
    expect("series" in drift).toBe(false);
    expect(drift).toMatchObject({ reason: "newer_split" });
    expect(mergeIncremental(stored, fresh, { newerSplit: false }).adjustmentDrift).toBe(false);
  });

  it("flags drift when nothing overlaps (adjustment cannot be proven)", () => {
    const stored = mk([1, 2, 3], [10, 11, 12]);
    const fresh = mk([20, 21], [13, 14]);
    const r = mergeIncremental(stored, fresh);
    expect(r.overlapBars).toBe(0);
    expect(r.adjustmentDrift).toBe(true);
    expect("series" in r).toBe(false);
    expect(r).toMatchObject({ reason: "no_overlap" });
  });

  it("keeps a stored bar the fresh window lacks (union by day) and leaves stored untouched when fresh is empty", () => {
    const stored = mk([1, 2, 3], [10, 11, 12]);
    const fresh = mk([1, 3, 4], [10, 12, 13]);
    expect(merged(mergeIncremental(stored, fresh)).series.dates).toEqual([1, 2, 3, 4]);
    const empty = merged(mergeIncremental(stored, mk([], [])));
    expect(empty.series.close).toEqual([10, 11, 12]);
    expect(empty.adjustmentDrift).toBe(false);
  });

  it("an empty stored series merges to the fresh series without drift", () => {
    const r = merged(mergeIncremental(mk([], []), mk([1, 2], [5, 6])));
    expect(r.series.dates).toEqual([1, 2]);
    expect(r.adjustmentDrift).toBe(false);
  });
});

describe("seriesStats", () => {
  it("matches the report of cleanBars and can be recomputed over a merged series", () => {
    const stored: Series = {
      dates: [1, 2, 3],
      open: [10, 10, 10],
      high: [11, 11, 11],
      low: [9, 9, 9],
      close: [10, 10, 10],
      volume: [1, 1, 1],
    };
    const fresh: Series = {
      dates: [3, 4],
      open: [10, 30],
      high: [11, 31],
      low: [9, 29],
      close: [10, 30],
      volume: [1, 1],
    };
    const r = mergeIncremental(stored, fresh);
    if (r.adjustmentDrift) throw new Error("unexpected drift");
    const stats = seriesStats(r.series);
    expect(stats.jumpAnomalies).toBe(1); // 10 -> 30
    expect(stats.ohlcInconsistent).toBe(0);
    expect(stats.suspect).toBe(false);
  });
});
