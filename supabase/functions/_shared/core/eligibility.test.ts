import { describe, expect, it } from "vitest";
import { dayNumber } from "./calendar.ts";
import {
  carryForwardEligible,
  evaluateTier1,
  evaluateTier2,
  MARKET_CAP_MIN_USD,
  marketCapUsd,
  type RuleCode,
  shouldCarryForward,
  type Tier1Input,
} from "./eligibility.ts";
import type { Channel, ChannelOutcome } from "./indicator.ts";
import { toMajor } from "./units.ts";

const risingChannel: ChannelOutcome = { ok: true, channel: { rising: true } as unknown as Channel };
const flatChannel: ChannelOutcome = { ok: true, channel: { rising: false } as unknown as Channel };
const sessionDay = dayNumber(2026, 10, 14);

/** A security that passes every Tier 1 rule. */
const passing: Tier1Input = {
  quoteType: "EQUITY",
  isCanonical: true,
  marketCapMajor: 60e9,
  marketCapAgeDays: 0,
  fxUsdPerUnit: 1,
  firstTradeDay: dayNumber(1999, 1, 22),
  dataSessionDay: sessionDay,
  validBars: 3200,
  freshness: "fresh",
  suspect: false,
  channel: risingChannel,
  settingsLength: 2500,
};
const failedOf = (patch: Partial<Tier1Input>): RuleCode[] =>
  evaluateTier1({ ...passing, ...patch }).failed;

describe("evaluateTier1: market cap boundary", () => {
  it("passes a market cap of exactly 50e9 (inclusive)", () => {
    const r = evaluateTier1({ ...passing, marketCapMajor: 50e9 });
    expect(r.member).toBe(true);
    expect(r.marketCapUsd).toBe(50e9);
  });
  it("fails 49,999,999,999 with market_cap_below_threshold", () => {
    const r = evaluateTier1({ ...passing, marketCapMajor: 49_999_999_999 });
    expect(r.member).toBe(false);
    expect(r.failed).toEqual(["market_cap_below_threshold"]);
    expect(r.marketCapUsd).toBe(49_999_999_999);
  });
  it("converts through FX: 7.4e12 JPY at 0.00633 USD is about 46.8e9 and fails", () => {
    expect(failedOf({ marketCapMajor: 7.4e12, fxUsdPerUnit: 0.00633 })).toEqual([
      "market_cap_below_threshold",
    ]);
    expect(failedOf({ marketCapMajor: 8e12, fxUsdPerUnit: 0.00633 })).toEqual([]);
  });
  it("GBp pitfall: SHEL.L has currency GBp but the market cap is already GBP, so only the price is divided", () => {
    const capGbp = 222.0e9; // spike 3.3
    const gbpUsd = 1.3249596;
    expect(marketCapUsd(capGbp, gbpUsd)).toBeCloseTo(294.1e9, -8);
    expect(failedOf({ marketCapMajor: capGbp, fxUsdPerUnit: gbpUsd })).toEqual([]);
    // dividing the cap by 100 (a minor-unit mix-up) would wrongly eject the company
    expect(failedOf({ marketCapMajor: toMajor(capGbp, "GBp"), fxUsdPerUnit: gbpUsd })).toEqual([
      "market_cap_below_threshold",
    ]);
  });
  it("marketCapUsd multiplies the major-unit cap by usd-per-unit", () => {
    expect(marketCapUsd(100, 1.5)).toBe(150);
  });
});

describe("evaluateTier1: missing and stale inputs", () => {
  it("market_cap_missing when the cap is null or NaN, with no USD value", () => {
    for (const cap of [null, Number.NaN]) {
      const r = evaluateTier1({ ...passing, marketCapMajor: cap });
      expect(r.failed).toEqual(["market_cap_missing"]);
      expect(r.marketCapUsd).toBeNull();
    }
  });
  it("market_cap_stale when the quote is older than 5 days (5 passes, 6 fails) or its age is unknown", () => {
    expect(failedOf({ marketCapAgeDays: 5 })).toEqual([]);
    expect(failedOf({ marketCapAgeDays: 6 })).toEqual(["market_cap_stale"]);
    expect(failedOf({ marketCapAgeDays: null })).toEqual(["market_cap_stale"]);
    expect(evaluateTier1({ ...passing, marketCapAgeDays: 6 }).marketCapUsd).toBeNull();
  });
  it("fx_missing when no usable rate exists", () => {
    expect(failedOf({ fxUsdPerUnit: null })).toEqual(["fx_missing"]);
    expect(failedOf({ fxUsdPerUnit: 0 })).toEqual(["fx_missing"]);
  });
  it("a stale cap and a missing rate are both reported", () => {
    expect(failedOf({ marketCapAgeDays: 9, fxUsdPerUnit: null })).toEqual([
      "market_cap_stale",
      "fx_missing",
    ]);
  });
});

describe("evaluateTier1: history, bars, data quality, channel", () => {
  it("passes a listing of exactly 10 years and fails one day less", () => {
    const exact = dayNumber(2016, 10, 14);
    expect(failedOf({ firstTradeDay: exact })).toEqual([]);
    expect(failedOf({ firstTradeDay: exact + 1 })).toEqual(["listing_too_new"]);
  });
  it("fails an unknown first trade date or session day", () => {
    expect(failedOf({ firstTradeDay: null })).toEqual(["listing_too_new"]);
    expect(failedOf({ dataSessionDay: null })).toEqual(["listing_too_new"]);
  });
  it("2,500 valid bars pass, 2,499 fail even when the listing is old enough", () => {
    expect(failedOf({ validBars: 2500 })).toEqual([]);
    expect(failedOf({ validBars: 2499 })).toEqual(["insufficient_bars"]);
  });
  it("the bar requirement follows settingsLength", () => {
    expect(failedOf({ validBars: 400, settingsLength: 400 })).toEqual([]);
    expect(failedOf({ validBars: 399, settingsLength: 400 })).toEqual(["insufficient_bars"]);
  });
  it("stale, unavailable and suspect data fail", () => {
    expect(failedOf({ freshness: "stale" })).toEqual(["stale_data"]);
    expect(failedOf({ freshness: "unavailable" })).toEqual(["stale_data"]);
    expect(failedOf({ suspect: true })).toEqual(["suspect_data"]);
  });
  it("channel outcomes map to codes", () => {
    expect(failedOf({ channel: flatChannel })).toEqual(["channel_not_rising"]);
    expect(failedOf({ channel: { ok: false, reason: "insufficient_bars" } })).toEqual([
      "insufficient_data_for_channel",
    ]);
    expect(failedOf({ channel: { ok: false, reason: "non_finite_input" } })).toEqual([
      "insufficient_data_for_channel",
    ]);
    expect(failedOf({ channel: { ok: false, reason: "invalid_settings" } })).toEqual([
      "unprocessed",
    ]);
    expect(failedOf({ channel: null })).toEqual(["unprocessed"]);
  });
  it("not_equity and not_canonical fail", () => {
    expect(failedOf({ quoteType: "ETF" })).toEqual(["not_equity"]);
    expect(failedOf({ isCanonical: false })).toEqual(["not_canonical"]);
  });
  it("lists ALL failures in declaration order", () => {
    const r = evaluateTier1({
      quoteType: "ETF",
      isCanonical: false,
      marketCapMajor: 1e9,
      marketCapAgeDays: 0,
      fxUsdPerUnit: 1,
      firstTradeDay: dayNumber(2020, 1, 1),
      dataSessionDay: sessionDay,
      validBars: 100,
      freshness: "stale",
      suspect: true,
      channel: flatChannel,
      settingsLength: 2500,
    });
    expect(r.member).toBe(false);
    expect(r.failed).toEqual([
      "not_equity",
      "market_cap_below_threshold",
      "not_canonical",
      "listing_too_new",
      "insufficient_bars",
      "stale_data",
      "suspect_data",
      "channel_not_rising",
    ]);
  });
  it("a fully passing security is a member", () => {
    expect(evaluateTier1(passing)).toEqual({ member: true, marketCapUsd: 60e9, failed: [] });
  });
});

describe("evaluateTier2", () => {
  const ok = { applicableLowerEnd: 12.5, close: 10, freshness: "fresh", signalGrade: true };
  it("is valid for a positive lower line, finite close, fresh data and signal-grade settings", () => {
    expect(evaluateTier2(ok)).toEqual({ valid: true, failed: [] });
  });
  it("lower line 0 and -0.01 fail, +0.01 passes (zero-line rule)", () => {
    expect(evaluateTier2({ ...ok, applicableLowerEnd: 0 }).failed).toEqual([
      "lower_line_not_positive",
    ]);
    expect(evaluateTier2({ ...ok, applicableLowerEnd: -0.01 }).failed).toEqual([
      "lower_line_not_positive",
    ]);
    expect(evaluateTier2({ ...ok, applicableLowerEnd: 0.01 }).valid).toBe(true);
  });
  it("fails a non-finite close, stale data and non signal-grade settings, in order", () => {
    expect(
      evaluateTier2({
        applicableLowerEnd: -1,
        close: Number.NaN,
        freshness: "stale",
        signalGrade: false,
      }).failed,
    ).toEqual(["lower_line_not_positive", "close_not_finite", "stale_data", "not_signal_grade"]);
    expect(evaluateTier2({ ...ok, close: null }).failed).toEqual(["close_not_finite"]);
  });
  it("a missing channel (no lower end) is unprocessed", () => {
    expect(evaluateTier2({ ...ok, applicableLowerEnd: null }).failed).toEqual(["unprocessed"]);
  });
});

describe("carryForwardEligible", () => {
  it("is true only when every failing rule is a missing, stale or unprocessed input", () => {
    expect(carryForwardEligible(["market_cap_stale"])).toBe(true);
    expect(
      carryForwardEligible(["market_cap_missing", "fx_missing", "stale_data", "unprocessed"]),
    ).toBe(true);
    expect(carryForwardEligible(["market_cap_below_threshold"])).toBe(false);
    expect(carryForwardEligible(["stale_data", "channel_not_rising"])).toBe(false);
    expect(carryForwardEligible([])).toBe(false);
  });
});

describe("shouldCarryForward", () => {
  it("carries a data-problem failure for 0 and 2 consecutive scans", () => {
    expect(shouldCarryForward(["market_cap_stale"], 0)).toEqual({
      carry: true,
      reason: "eligible",
    });
    expect(shouldCarryForward(["fx_missing"], 2)).toEqual({ carry: true, reason: "eligible" });
  });
  it("stops at the cap of 3 consecutive scans", () => {
    expect(shouldCarryForward(["market_cap_stale"], 3)).toEqual({
      carry: false,
      reason: "cap_reached",
    });
    expect(shouldCarryForward(["market_cap_stale"], 4).carry).toBe(false);
  });
  it("never carries a genuine ineligibility", () => {
    expect(shouldCarryForward(["market_cap_below_threshold"], 0)).toEqual({
      carry: false,
      reason: "not_carry_forward_failure",
    });
    expect(shouldCarryForward([], 0).reason).toBe("not_carry_forward_failure");
  });
});

describe("constants", () => {
  it("the market cap floor is 50 billion USD", () => {
    expect(MARKET_CAP_MIN_USD).toBe(50_000_000_000);
  });
});
