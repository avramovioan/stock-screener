import { subtractYears } from "./calendar.ts";
import type { ChannelOutcome } from "./indicator.ts";

/** Inclusive market-cap floor in USD (D11). */
export const MARKET_CAP_MIN_USD = 50e9;
/** A quote older than this many calendar days gives a stale market cap, treated as missing (A-02). */
export const MARKET_CAP_MAX_AGE_DAYS = 5;
/** A listing needs this many years of history (D11). */
export const MIN_LISTING_YEARS = 10;
/** A security failing only on missing inputs stays in membership this many consecutive scans (A-02). */
export const MAX_CARRY_FORWARD_SCANS = 3;

export type RuleCode =
  | "not_equity"
  | "market_cap_missing"
  | "market_cap_stale"
  | "fx_missing"
  | "market_cap_below_threshold"
  | "not_canonical"
  | "listing_too_new"
  | "insufficient_bars"
  | "stale_data"
  | "suspect_data"
  | "insufficient_data_for_channel"
  | "channel_not_rising"
  | "lower_line_not_positive"
  | "close_not_finite"
  | "not_signal_grade"
  | "unprocessed"
  | "no_price_data";

export interface Tier1Input {
  quoteType: string;
  isCanonical: boolean;
  marketCapMajor: number | null;
  marketCapAgeDays: number | null;
  fxUsdPerUnit: number | null;
  firstTradeDay: number | null;
  dataSessionDay: number | null;
  validBars: number;
  freshness: "fresh" | "stale" | "unavailable";
  suspect: boolean;
  channel: ChannelOutcome | null;
  settingsLength: number;
}

export interface Tier1Result {
  member: boolean;
  marketCapUsd: number | null;
  failed: RuleCode[];
}

/** marketCapMajor * fxUsdPerUnit. The market cap is in the MAJOR unit already (GBP for a GBp listing); it is never divided. */
export function marketCapUsd(marketCapMajor: number, fxUsdPerUnit: number): number {
  return marketCapMajor * fxUsdPerUnit;
}

/** Tier 1 (membership, rank independent). `failed` lists ALL failing rules, in the declaration order of RuleCode. */
export function evaluateTier1(i: Tier1Input): Tier1Result {
  const failed: RuleCode[] = [];
  let usd: number | null = null;

  // (a)
  if (i.quoteType !== "EQUITY") failed.push("not_equity");

  // (b) market cap known, fresh, convertible and >= 50e9 USD (inclusive)
  const capKnown = i.marketCapMajor !== null && Number.isFinite(i.marketCapMajor);
  let capUsable = false;
  if (!capKnown) {
    failed.push("market_cap_missing");
  } else if (i.marketCapAgeDays === null || i.marketCapAgeDays > MARKET_CAP_MAX_AGE_DAYS) {
    failed.push("market_cap_stale"); // an unknown quote time cannot prove freshness
  } else {
    capUsable = true;
  }
  const fxKnown = i.fxUsdPerUnit !== null && Number.isFinite(i.fxUsdPerUnit) && i.fxUsdPerUnit > 0;
  if (capKnown && !fxKnown) failed.push("fx_missing");
  if (capUsable && fxKnown) {
    usd = marketCapUsd(i.marketCapMajor as number, i.fxUsdPerUnit as number);
    if (usd < MARKET_CAP_MIN_USD) failed.push("market_cap_below_threshold");
  }

  // (c)
  if (!i.isCanonical) failed.push("not_canonical");

  // (d) exactly ten years passes; one day less fails; unknown dates fail
  if (
    i.firstTradeDay === null ||
    i.dataSessionDay === null ||
    i.firstTradeDay > subtractYears(i.dataSessionDay, MIN_LISTING_YEARS)
  ) {
    failed.push("listing_too_new");
  }

  // (e)
  if (i.validBars < i.settingsLength) failed.push("insufficient_bars");

  // (f)
  if (i.freshness !== "fresh") failed.push("stale_data");
  if (i.suspect) failed.push("suspect_data");

  // (g)
  if (i.channel !== null) {
    if (i.channel.ok) {
      if (!i.channel.channel.rising) failed.push("channel_not_rising");
    } else if (i.channel.reason === "invalid_settings") {
      failed.push("unprocessed");
    } else {
      failed.push("insufficient_data_for_channel");
    }
  } else {
    failed.push("unprocessed");
  }

  // keep the documented order even though "unprocessed" can be pushed from the channel branch
  const order: RuleCode[] = [
    "not_equity",
    "market_cap_missing",
    "market_cap_stale",
    "fx_missing",
    "market_cap_below_threshold",
    "not_canonical",
    "listing_too_new",
    "insufficient_bars",
    "stale_data",
    "suspect_data",
    "insufficient_data_for_channel",
    "channel_not_rising",
    "lower_line_not_positive",
    "close_not_finite",
    "not_signal_grade",
    "unprocessed",
    "no_price_data",
  ];
  failed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { member: failed.length === 0, marketCapUsd: usd, failed };
}

/** Tier 2 (signal validity, rank dependent). Order: (h) lower line, (i) close, (j) fresh, (k) signal grade. */
export function evaluateTier2(i: {
  applicableLowerEnd: number | null;
  close: number | null;
  freshness: string;
  signalGrade: boolean;
}): { valid: boolean; failed: RuleCode[] } {
  const failed: RuleCode[] = [];
  if (i.applicableLowerEnd === null) failed.push("unprocessed");
  else if (!(i.applicableLowerEnd > 0)) failed.push("lower_line_not_positive");
  if (i.close === null || !Number.isFinite(i.close)) failed.push("close_not_finite");
  if (i.freshness !== "fresh") failed.push("stale_data");
  if (!i.signalGrade) failed.push("not_signal_grade");
  return { valid: failed.length === 0, failed };
}

const CARRY_FORWARD_CODES: ReadonlySet<RuleCode> = new Set<RuleCode>([
  "market_cap_missing",
  "market_cap_stale",
  "fx_missing",
  "stale_data",
  "insufficient_data_for_channel",
  "unprocessed",
]);

/** True when every failing rule is a missing/stale/unprocessed INPUT (a data problem), never a genuine ineligibility. */
export function carryForwardEligible(failed: readonly RuleCode[]): boolean {
  return failed.length > 0 && failed.every((c) => CARRY_FORWARD_CODES.has(c));
}

/** Carry-forward decision (A-02): only data-problem failures carry, and at most MAX_CARRY_FORWARD_SCANS consecutive scans. */
export function shouldCarryForward(
  failed: RuleCode[],
  consecutiveCarried: number,
): { carry: boolean; reason: "eligible" | "cap_reached" | "not_carry_forward_failure" } {
  if (!carryForwardEligible(failed)) return { carry: false, reason: "not_carry_forward_failure" };
  if (consecutiveCarried >= MAX_CARRY_FORWARD_SCANS) return { carry: false, reason: "cap_reached" };
  return { carry: true, reason: "eligible" };
}
