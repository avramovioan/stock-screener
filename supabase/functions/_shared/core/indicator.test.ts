import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/stddevchn-synthetic.json";
import {
  assertSignalGradeSettings,
  type Channel,
  computeChannel,
  DEFAULT_SETTINGS,
  type IndicatorSettings,
  isRising,
  type Segment,
  validateSettings,
  valueAt,
} from "./indicator.ts";

interface LineExpect {
  start: number;
  end: number;
  startBarOffsetFromWindowStart?: number;
}
interface Fixture {
  id: string;
  length: number;
  inputs: { close: number[]; high: number[]; low: number[] };
  settings: Omit<IndicatorSettings, "length">;
  expected: null | {
    slope: number;
    average: number;
    intercept: number;
    stPrice: number;
    endPrice: number;
    stdDev: number;
    pearsonR: number;
    upDev: number;
    dnDev: number;
    lines: Record<"base" | "upper1" | "upper2" | "lower1" | "lower2", LineExpect>;
    risingChannel: boolean;
    lower2EndAboveZero: boolean;
  };
}

const all = fixtures as unknown as Fixture[];
const byId = (id: string): Fixture => {
  const f = all.find((x) => x.id === id);
  if (f === undefined) throw new Error(`fixture ${id} missing`);
  return f;
};

/** |actual - expected| <= max(1e-12 * |expected|, 1e-9)  (D10, pine 6) */
function near(actual: number, expected: number, label: string): void {
  const tol = Math.max(1e-12 * Math.abs(expected), 1e-9);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tol,
  );
}

function run(f: Fixture): Channel {
  const out = computeChannel(f.inputs, { length: f.length, ...f.settings });
  if (!out.ok) throw new Error(`${f.id}: ${out.reason}`);
  return out.channel;
}

function checkFixture(f: Fixture): void {
  const e = f.expected;
  if (e === null) throw new Error("fixture has no expectation");
  const ch = run(f);
  near(ch.slope, e.slope, "slope");
  near(ch.average, e.average, "average");
  near(ch.intercept, e.intercept, "intercept");
  near(ch.stPrice, e.stPrice, "stPrice");
  near(ch.endPrice, e.endPrice, "endPrice");
  near(ch.stdDev, e.stdDev, "stdDev");
  near(ch.pearsonR, e.pearsonR, "pearsonR");
  near(ch.upDev, e.upDev, "upDev");
  near(ch.dnDev, e.dnDev, "dnDev");
  const segs: Array<["base" | "upper1" | "upper2" | "lower1" | "lower2", Segment]> = [
    ["base", ch.base],
    ["upper1", ch.upper1],
    ["upper2", ch.upper2],
    ["lower1", ch.lower1],
    ["lower2", ch.lower2],
  ];
  for (const [name, seg] of segs) {
    const line = e.lines[name];
    near(seg.y1, line.start, `${name}.start`);
    near(seg.y2, line.end, `${name}.end`);
    expect(seg.x1).toBe(ch.windowStartIndex + (line.startBarOffsetFromWindowStart ?? 0));
    expect(seg.x2).toBe(ch.lastIndex);
  }
  near(ch.end.base, e.lines.base.end, "end.base");
  near(ch.end.upper1, e.lines.upper1.end, "end.upper1");
  near(ch.end.upper2, e.lines.upper2.end, "end.upper2");
  near(ch.end.lower1, e.lines.lower1.end, "end.lower1");
  near(ch.end.lower2, e.lines.lower2.end, "end.lower2");
  expect(ch.rising).toBe(e.risingChannel);
  expect(ch.end.lower2 > 0).toBe(e.lower2EndAboveZero);
}

describe("indicator parity fixtures (stddevchn-synthetic.json)", () => {
  it("contains the nine fixtures F1..F9", () => {
    expect(all.map((f) => f.id)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"]);
  });

  for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F9"]) {
    it(`${id}: every level matches (relative 1e-12, absolute floor 1e-9)`, () => {
      checkFixture(byId(id));
    });
  }

  it("F1: rising channel has raw slope -1 and set-2 lines start one bar later", () => {
    const ch = run(byId("F1"));
    expect(ch.slope).toBe(-1);
    expect(ch.rising).toBe(true);
    expect(ch.upper2.x1).toBe(ch.upper1.x1 + 1);
    expect(ch.lower2.x1).toBe(ch.lower1.x1 + 1);
  });

  it("F2: falling channel has raw slope +1 and is not rising", () => {
    const ch = run(byId("F2"));
    expect(ch.slope).toBe(1);
    expect(ch.rising).toBe(false);
  });

  it("F3: a flat series is not rising", () => {
    const ch = run(byId("F3"));
    expect(ch.stdDev).toBe(0);
    expect(ch.pearsonR).toBe(0);
    expect(ch.rising).toBe(false);
  });

  it("F4: script-order slope differs from the exact rational by about 1.2e-14 relative", () => {
    const ch = run(byId("F4"));
    const exact = -0.7107142857142857;
    const rel = Math.abs(ch.slope - exact) / Math.abs(exact);
    expect(rel).toBeGreaterThan(1e-15);
    expect(rel).toBeLessThan(1e-13);
  });

  it("F5: mode false uses the maximum high/low deviation, so set 1 equals set 2", () => {
    const ch = run(byId("F5"));
    expect(ch.end.upper1).toBe(ch.end.upper2);
    expect(ch.end.lower1).toBe(ch.end.lower2);
    near(ch.end.upper1, ch.endPrice + ch.upDev, "upper end = end + upDev");
    near(ch.end.lower1, ch.endPrice - ch.dnDev, "lower end = end - dnDev");
  });

  it("F6: the lower -4 end is at or below zero", () => {
    const ch = run(byId("F6"));
    expect(ch.rising).toBe(true);
    expect(ch.end.lower2).toBeLessThan(0);
    near(ch.end.lower2, -1.699599499978905, "lower2 end");
  });

  it("F7: bars older than the window have no effect (window boundary)", () => {
    const f4 = run(byId("F4"));
    const f7 = run(byId("F7"));
    const strip = (c: Channel) => ({
      ...c,
      barCount: 0,
      lastIndex: 0,
      windowStartIndex: 0,
      base: 0,
      upper1: 0,
      upper2: 0,
      lower1: 0,
      lower2: 0,
    });
    expect(strip(f7)).toEqual(strip(f4));
    expect(f7.barCount).toBe(12);
    expect(f7.windowStartIndex).toBe(4);
    expect(f7.lastIndex).toBe(11);
  });

  it("F7: non-finite values OUTSIDE the window are ignored", () => {
    const f = byId("F7");
    const close = [Number.NaN, ...f.inputs.close.slice(1)];
    const out = computeChannel({ ...f.inputs, close }, { length: f.length, ...f.settings });
    expect(out.ok).toBe(true);
  });

  it("F8: fewer bars than length is insufficient_bars, not an error", () => {
    const f = byId("F8");
    expect(f.expected).toBeNull();
    expect(computeChannel(f.inputs, { length: f.length, ...f.settings })).toEqual({
      ok: false,
      reason: "insufficient_bars",
    });
  });

  it("F9: float-noise constant series records noisy raw values and is not rising", () => {
    const ch = run(byId("F9"));
    expect(ch.stdDev).toBeLessThan(1e-9);
    expect(ch.rising).toBe(false);
  });
});

describe("validateSettings", () => {
  const base = { ...DEFAULT_SETTINGS };
  const bad = (patch: Record<string, unknown>) => validateSettings({ ...base, ...patch });

  it("accepts the defaults without warnings", () => {
    const r = validateSettings(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).toEqual(DEFAULT_SETTINGS);
      expect(r.warnings).toEqual([]);
    }
  });

  it.each([
    [3, true],
    [5000, true],
    [2, false],
    [5001, false],
    [2500.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [-5, false],
    ["2500", false],
    [null, false],
  ])("length %s -> accepted %s", (length, accepted) => {
    const r = bad({ length });
    expect(r.ok).toBe(accepted);
    if (!r.ok) expect(r.issues.some((i) => i.field === "length")).toBe(true);
  });

  it("warns (but accepts) a length below 30", () => {
    const r = bad({ length: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.map((w) => w.code)).toEqual(["length_below_30"]);
  });

  it.each(["upper1Mult", "upper2Mult", "lower1Mag", "lower2Mag"])(
    "rejects zero, negative, NaN and string for %s",
    (field) => {
      for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
        const r = bad({ [field]: v });
        expect(r.ok, `${field}=${String(v)}`).toBe(false);
      }
    },
  );

  it.each(["upper1Mode", "upper2Mode", "lower1Mode", "lower2Mode"])(
    "rejects non-boolean %s (no truthy coercion)",
    (field) => {
      for (const v of [1, 0, "true", null]) {
        const r = bad({ [field]: v });
        expect(r.ok, `${field}=${String(v)}`).toBe(false);
      }
    },
  );

  it("reports every missing field when the input is not an object", () => {
    for (const input of [null, undefined, 5, "x", []]) {
      const r = validateSettings(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues).toHaveLength(9);
    }
  });

  it("collects all issues at once", () => {
    const r = bad({ length: 1, upper1Mult: 0, lower2Mode: "yes" });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.map((i) => i.field).sort()).toEqual(["length", "lower2Mode", "upper1Mult"]);
  });
});

describe("assertSignalGradeSettings", () => {
  it("accepts the defaults and any length", () => {
    expect(() => assertSignalGradeSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, length: 500 })).not.toThrow();
  });
  it("throws settings_not_signal_grade for a changed magnitude or a false mode", () => {
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, lower1Mag: 2 })).toThrow(
      "settings_not_signal_grade",
    );
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, upper2Mult: 3 })).toThrow(
      "settings_not_signal_grade",
    );
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, lower2Mode: false })).toThrow(
      "settings_not_signal_grade",
    );
  });
});

describe("computeChannel edge cases", () => {
  it("returns invalid_settings for bad settings", () => {
    const f = byId("F4");
    expect(computeChannel(f.inputs, { ...DEFAULT_SETTINGS, length: 2 })).toEqual({
      ok: false,
      reason: "invalid_settings",
    });
  });

  it("returns non_finite_input when a window value is NaN or Infinity", () => {
    const f = byId("F4");
    const nan = [...f.inputs.close];
    nan[6] = Number.NaN;
    expect(
      computeChannel({ ...f.inputs, close: nan }, { length: f.length, ...f.settings }),
    ).toEqual({ ok: false, reason: "non_finite_input" });
    const inf = [...f.inputs.high];
    inf[0] = Number.POSITIVE_INFINITY;
    expect(computeChannel({ ...f.inputs, high: inf }, { length: f.length, ...f.settings })).toEqual(
      { ok: false, reason: "non_finite_input" },
    );
  });

  it("throws on mismatched array lengths (programming error)", () => {
    expect(() =>
      computeChannel(
        { close: [1, 2, 3], high: [1, 2], low: [1, 2, 3] },
        { ...DEFAULT_SETTINGS, length: 3 },
      ),
    ).toThrow(RangeError);
  });

  it("exactly L bars computes and L-1 bars is insufficient", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => 100 + i * 0.01 + Math.sin(i) * 0.3);
    const settings = { ...DEFAULT_SETTINGS, length: 2500 };
    const at = (n: number) => {
      const close = mk(n);
      return computeChannel(
        { close, high: close.map((c) => c + 0.2), low: close.map((c) => c - 0.2) },
        settings,
      );
    };
    expect(at(2500).ok).toBe(true);
    expect(at(2499)).toEqual({ ok: false, reason: "insufficient_bars" });
  });

  it("2,500 bars of the constant 123.456 are NOT rising (float noise must not look like a trend)", () => {
    const close = Array.from({ length: 2500 }, () => 123.456);
    const out = computeChannel({
      close,
      high: close.map((c) => c + 0.5),
      low: close.map((c) => c - 0.5),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel.rising).toBe(false);
      expect(Math.abs(out.channel.endPrice - out.channel.stPrice)).toBeLessThan(1e-9);
    }
  });

  it("a clean 2,500-bar uptrend is rising with raw slope below zero", () => {
    const close = Array.from({ length: 2500 }, (_, i) => 50 + i * 0.05 + Math.sin(i / 7) * 0.4);
    const out = computeChannel({
      close,
      high: close.map((c) => c + 0.3),
      low: close.map((c) => c - 0.3),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel.rising).toBe(true);
      expect(out.channel.slope).toBeLessThan(0);
      expect(out.channel.lower1.y2).toBeLessThan(out.channel.base.y2);
      expect(out.channel.lower2.y2).toBeLessThan(out.channel.lower1.y2);
    }
  });

  it("a 5,000-bar window with length 5000 computes", () => {
    const close = Array.from({ length: 5000 }, (_, i) => 20 + i * 0.01 + Math.cos(i / 11));
    const out = computeChannel(
      { close, high: close.map((c) => c + 0.1), low: close.map((c) => c - 0.1) },
      { ...DEFAULT_SETTINGS, length: 5000 },
    );
    expect(out.ok).toBe(true);
  });

  it("length 3 gives a defined set-2 line (x2 - x1 = 1)", () => {
    const out = computeChannel(
      { close: [1, 2, 4], high: [1.5, 2.5, 4.5], low: [0.5, 1.5, 3.5] },
      { ...DEFAULT_SETTINGS, length: 3 },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel.upper2.x2 - out.channel.upper2.x1).toBe(1);
      expect(Number.isFinite(out.channel.upper2.slopePerBar)).toBe(true);
    }
  });
});

describe("isRising", () => {
  it("is false for equal prices and for noise at 1e-14 relative", () => {
    expect(isRising(100, 100)).toBe(false);
    expect(isRising(123.456, 123.456 + 2.4e-11)).toBe(false);
  });
  it("is true just above the relative epsilon and false just below", () => {
    expect(isRising(1000, 1000 + 1.1e-6)).toBe(true);
    expect(isRising(1000, 1000 + 0.9e-6)).toBe(false);
  });
  it("uses an absolute floor of 1e-9 for tiny prices", () => {
    expect(isRising(0.001, 0.001 + 2e-9)).toBe(true);
    expect(isRising(0.001, 0.001 + 5e-10)).toBe(false);
  });
});

describe("valueAt (extend right)", () => {
  it("returns the right end at x2 and extends with the drawn slope", () => {
    const seg: Segment = { x1: 0, y1: 10, x2: 10, y2: 20, slopePerBar: 1 };
    expect(valueAt(seg, 10)).toBe(20);
    expect(valueAt(seg, 15)).toBe(25);
    expect(valueAt(seg, 4)).toBe(14);
  });
  it("F4 set-2 lines are drawn steeper than the true slope by (L-1)/(L-2)", () => {
    const f = byId("F4");
    const ch = run(f);
    const L = f.length;
    const trueSlope = (ch.endPrice - ch.stPrice) / (L - 1);
    expect(ch.base.slopePerBar).toBeCloseTo(trueSlope, 12);
    expect(ch.upper1.slopePerBar).toBeCloseTo(trueSlope, 12);
    expect(ch.upper2.slopePerBar / ch.upper1.slopePerBar).toBeCloseTo((L - 1) / (L - 2), 12);
    // five bars to the right: set 2 sits above the exact extension (F4 analysis: 0.592)
    const drawn = valueAt(ch.upper2, ch.lastIndex + 5);
    const exact = ch.end.upper2 + 5 * trueSlope;
    expect(drawn - exact).toBeCloseTo(0.592, 2);
  });
  it("at L = 2500 the factor is 1.00040032", () => {
    const close = Array.from({ length: 2500 }, (_, i) => 50 + i * 0.05 + Math.sin(i / 7) * 0.4);
    const out = computeChannel({
      close,
      high: close.map((c) => c + 0.3),
      low: close.map((c) => c - 0.3),
    });
    if (!out.ok) throw new Error("expected channel");
    expect(out.channel.upper2.slopePerBar / out.channel.upper1.slopePerBar).toBeCloseTo(
      1.00040032,
      8,
    );
  });
});
