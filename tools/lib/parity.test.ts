import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../supabase/functions/_shared/core/indicator.ts";
import { buildParityReport, formatParityReport } from "./parity.ts";

const dates = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"];
const close = [10, 11, 12, 13, 14];
const series = {
  dates,
  close,
  high: close.map((c) => c + 0.5),
  low: close.map((c) => c - 0.5),
};
const settings = { ...DEFAULT_SETTINGS, length: 5 };

describe("buildParityReport", () => {
  it("reproduces the rising linear fixture (F1) and names the window dates", () => {
    const r = buildParityReport(series, { settings });
    if (!r.ok) throw new Error(r.reason);
    expect(r.windowStartDate).toBe("2026-10-01");
    expect(r.lastDate).toBe("2026-10-07");
    expect(r.stPrice).toBeCloseTo(10, 9);
    expect(r.endPrice).toBeCloseTo(14, 9);
    expect(r.stdDev).toBeCloseTo(0, 9);
    expect(r.rising).toBe(true);
    expect(r.lastBars).toHaveLength(5);
    expect(r.lines.map((l) => l.name)).toEqual(["upper2", "upper1", "base", "lower1", "lower2"]);
  });
  it("uses only bars up to the as-of date", () => {
    const r = buildParityReport(series, {
      asOf: "2026-10-05",
      settings: { ...DEFAULT_SETTINGS, length: 3 },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.lastDate).toBe("2026-10-05");
    expect(r.barCount).toBe(3);
  });
  it("reports insufficient bars instead of throwing", () => {
    expect(buildParityReport(series, { settings: DEFAULT_SETTINGS })).toEqual({
      ok: false,
      reason: "insufficient_bars",
    });
  });
  it("prints full precision values and the comparison tolerance rule", () => {
    const r = buildParityReport(series, { settings });
    if (!r.ok) throw new Error(r.reason);
    const text = formatParityReport("TEST", r);
    expect(text).toContain("symbol: TEST");
    expect(text).toContain("stPrice: 10");
    expect(text).toContain("0.5 * 10^-p");
  });
});
