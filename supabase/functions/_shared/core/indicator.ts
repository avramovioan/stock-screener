export interface IndicatorSettings {
  length: number; // integer, 3..5000, default 2500
  upper1Mode: boolean;
  upper1Mult: number; // default true, 1   (Pine upprinp / upprmltinp)
  upper2Mode: boolean;
  upper2Mult: number; // default true, 2   (upprinp2 / upprmltinp2)
  lower1Mode: boolean;
  lower1Mag: number; // default true, 3   (lwrinp / lwrMultInput), magnitude, applied as -mag
  lower2Mode: boolean;
  lower2Mag: number; // default true, 4   (lwrinp2 / lwrmultinp), magnitude, applied as -mag
}

export const DEFAULT_SETTINGS: Readonly<IndicatorSettings> = Object.freeze({
  length: 2500,
  upper1Mode: true,
  upper1Mult: 1,
  upper2Mode: true,
  upper2Mult: 2,
  lower1Mode: true,
  lower1Mag: 3,
  lower2Mode: true,
  lower2Mag: 4,
});

export const MIN_LENGTH = 3;
export const MAX_LENGTH = 5000;
export const WARN_LENGTH_BELOW = 30;
/** Relative epsilon of the flat-series noise guard (D10). */
export const RISING_EPSILON = 1e-9;

export interface SettingsIssue {
  field: keyof IndicatorSettings;
  code: string;
  message: string;
}

const BOOLEAN_FIELDS = ["upper1Mode", "upper2Mode", "lower1Mode", "lower2Mode"] as const;
const MAGNITUDE_FIELDS = ["upper1Mult", "upper2Mult", "lower1Mag", "lower2Mag"] as const;

export function validateSettings(
  input: unknown,
):
  | { ok: true; settings: IndicatorSettings; warnings: SettingsIssue[] }
  | { ok: false; issues: SettingsIssue[] } {
  const record: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const issues: SettingsIssue[] = [];
  const warnings: SettingsIssue[] = [];

  const length = record["length"];
  if (length === undefined) {
    issues.push({ field: "length", code: "missing", message: "length is required" });
  } else if (typeof length !== "number" || !Number.isFinite(length) || !Number.isInteger(length)) {
    issues.push({
      field: "length",
      code: "length_not_integer",
      message: "length must be a finite integer",
    });
  } else if (length < MIN_LENGTH || length > MAX_LENGTH) {
    issues.push({
      field: "length",
      code: "length_out_of_range",
      message: `length must be between ${MIN_LENGTH} and ${MAX_LENGTH}`,
    });
  } else if (length < WARN_LENGTH_BELOW) {
    warnings.push({
      field: "length",
      code: "length_below_30",
      message: "length below 30 gives a very noisy channel",
    });
  }

  for (const field of MAGNITUDE_FIELDS) {
    const v = record[field];
    if (v === undefined) {
      issues.push({ field, code: "missing", message: `${field} is required` });
    } else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      issues.push({
        field,
        code: "not_finite_positive",
        message: `${field} must be a finite number greater than 0`,
      });
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    const v = record[field];
    if (v === undefined) {
      issues.push({ field, code: "missing", message: `${field} is required` });
    } else if (typeof v !== "boolean") {
      issues.push({
        field,
        code: "not_boolean",
        message: `${field} must be a boolean (no truthy coercion)`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  const settings: IndicatorSettings = {
    length: record["length"] as number,
    upper1Mode: record["upper1Mode"] as boolean,
    upper1Mult: record["upper1Mult"] as number,
    upper2Mode: record["upper2Mode"] as boolean,
    upper2Mult: record["upper2Mult"] as number,
    lower1Mode: record["lower1Mode"] as boolean,
    lower1Mag: record["lower1Mag"] as number,
    lower2Mode: record["lower2Mode"] as boolean,
    lower2Mag: record["lower2Mag"] as number,
  };
  return { ok: true, settings, warnings };
}

/** Throws unless the 3/4/1/2 magnitudes and all four modes are the signal-grade defaults. Only `length` may vary (A-34). */
export function assertSignalGradeSettings(s: IndicatorSettings): void {
  const ok =
    s.upper1Mode === true &&
    s.upper2Mode === true &&
    s.lower1Mode === true &&
    s.lower2Mode === true &&
    s.upper1Mult === DEFAULT_SETTINGS.upper1Mult &&
    s.upper2Mult === DEFAULT_SETTINGS.upper2Mult &&
    s.lower1Mag === DEFAULT_SETTINGS.lower1Mag &&
    s.lower2Mag === DEFAULT_SETTINGS.lower2Mag;
  if (!ok) throw new Error("settings_not_signal_grade");
}

export interface OhlcSeries {
  // chronological, oldest first, VALID bars only, completed bars only
  close: ArrayLike<number>; // source = close (D10)
  high: ArrayLike<number>;
  low: ArrayLike<number>;
}

export interface Segment {
  // a line in bar-index space (index 0 = oldest bar of the supplied series)
  x1: number;
  y1: number; // left end
  x2: number;
  y2: number; // right end (always lastIndex)
  slopePerBar: number; // (y2 - y1) / (x2 - x1): the DRAWN slope used for right extension
}

export interface Channel {
  length: number;
  barCount: number;
  lastIndex: number; // barCount - 1 (latest completed bar)
  windowStartIndex: number; // lastIndex - length + 1
  slope: number;
  average: number;
  intercept: number; // raw Pine values (slope is NEGATIVE for a rising channel)
  stPrice: number;
  endPrice: number; // base line left / right values
  stdDev: number;
  pearsonR: number;
  upDev: number;
  dnDev: number;
  base: Segment; // x1 = windowStartIndex, y1 = stPrice, x2 = lastIndex, y2 = endPrice
  upper1: Segment;
  lower1: Segment; // set 1: x1 = windowStartIndex
  upper2: Segment;
  lower2: Segment; // set 2: x1 = windowStartIndex + 1 (one bar later), y1 = the set-2 value computed from stPrice
  end: { base: number; upper1: number; upper2: number; lower1: number; lower2: number }; // exact right-end values at lastIndex
  rising: boolean; // isRising(stPrice, endPrice)
}

export type ChannelOutcome =
  | { ok: true; channel: Channel }
  | { ok: false; reason: "invalid_settings" | "insufficient_bars" | "non_finite_input" };

/** A visually rising channel has end > st. The sign of the raw slope is never the test (Pine x runs newest to oldest). */
export function isRising(stPrice: number, endPrice: number): boolean {
  return endPrice - stPrice > RISING_EPSILON * Math.max(1, Math.abs(endPrice), Math.abs(stPrice));
}

/** seg.y2 + (x - seg.x2) * seg.slopePerBar (Pine extend.right). */
export function valueAt(seg: Segment, x: number): number {
  return seg.y2 + (x - seg.x2) * seg.slopePerBar;
}

function segment(x1: number, y1: number, x2: number, y2: number): Segment {
  return { x1, y1, x2, y2, slopePerBar: (y2 - y1) / (x2 - x1) };
}

export function computeChannel(
  series: OhlcSeries,
  settings: IndicatorSettings = DEFAULT_SETTINGS,
): ChannelOutcome {
  const checked = validateSettings(settings);
  if (!checked.ok) return { ok: false, reason: "invalid_settings" };
  const s = checked.settings;
  const n = series.close.length;
  if (series.high.length !== n || series.low.length !== n) {
    throw new RangeError("close, high and low must have the same length");
  }
  const L = s.length;
  if (L > n) return { ok: false, reason: "insufficient_bars" };

  // newest-first accessors: i = 0 is the latest completed bar
  const src = (i: number): number => series.close[n - 1 - i] as number;
  const hi = (i: number): number => series.high[n - 1 - i] as number;
  const lo = (i: number): number => series.low[n - 1 - i] as number;

  for (let i = 0; i < L; i++) {
    if (!Number.isFinite(src(i)) || !Number.isFinite(hi(i)) || !Number.isFinite(lo(i))) {
      return { ok: false, reason: "non_finite_input" };
    }
  }

  let sumX = 0;
  let sumY = 0;
  let sumXSqr = 0;
  let sumXY = 0;
  for (let i = 0; i < L; i++) {
    const v = src(i);
    const per = i + 1;
    sumX += per;
    sumY += v;
    sumXSqr += per * per;
    sumXY += v * per;
  }
  const slope = (L * sumXY - sumX * sumY) / (L * sumXSqr - sumX * sumX);
  const average = sumY / L;
  const intercept = average - (slope * sumX) / L + slope; // left to right, as Pine evaluates it
  const stPrice = intercept + slope * (L - 1);
  const endPrice = intercept;

  const periods = L - 1;
  const daY = intercept + (slope * periods) / 2;
  let val = intercept;
  let upDev = 0;
  let dnDev = 0;
  let acc = 0;
  let dsxx = 0;
  let dsyy = 0;
  let dsxy = 0;
  for (let j = 0; j <= periods; j++) {
    let p = hi(j) - val;
    if (p > upDev) upDev = p;
    p = val - lo(j);
    if (p > dnDev) dnDev = p;
    p = src(j);
    const dxt = p - average;
    const dyt = val - daY;
    p = p - val;
    acc += p * p;
    dsxx += dxt * dxt;
    dsyy += dyt * dyt;
    dsxy += dxt * dyt;
    val += slope;
  }
  const stdDev = Math.sqrt(acc / (periods === 0 ? 1 : periods)); // divisor L-1, NOT L
  const pearsonR = dsxx === 0 || dsyy === 0 ? 0 : dsxy / Math.sqrt(dsxx * dsyy);

  const offUp1 = s.upper1Mode ? +s.upper1Mult * stdDev : +upDev;
  const offUp2 = s.upper2Mode ? +s.upper2Mult * stdDev : +upDev;
  const offLo1 = s.lower1Mode ? -s.lower1Mag * stdDev : -dnDev;
  const offLo2 = s.lower2Mode ? -s.lower2Mag * stdDev : -dnDev;

  const lastIndex = n - 1;
  const windowStartIndex = lastIndex - L + 1;
  const channel: Channel = {
    length: L,
    barCount: n,
    lastIndex,
    windowStartIndex,
    slope,
    average,
    intercept,
    stPrice,
    endPrice,
    stdDev,
    pearsonR,
    upDev,
    dnDev,
    base: segment(windowStartIndex, stPrice, lastIndex, endPrice),
    upper1: segment(windowStartIndex, stPrice + offUp1, lastIndex, endPrice + offUp1),
    lower1: segment(windowStartIndex, stPrice + offLo1, lastIndex, endPrice + offLo1),
    upper2: segment(windowStartIndex + 1, stPrice + offUp2, lastIndex, endPrice + offUp2),
    lower2: segment(windowStartIndex + 1, stPrice + offLo2, lastIndex, endPrice + offLo2),
    end: {
      base: endPrice,
      upper1: endPrice + offUp1,
      upper2: endPrice + offUp2,
      lower1: endPrice + offLo1,
      lower2: endPrice + offLo2,
    },
    rising: isRising(stPrice, endPrice),
  };
  return { ok: true, channel };
}
