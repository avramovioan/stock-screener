import { describe, expect, it } from "vitest";
import {
  AUTO_REFRESH_MS,
  dailySyncDue,
  expectedStatementDate,
  MANUAL_COOLDOWN_S,
  statementFreshness,
  t1Disclosure,
} from "./statement-day.ts";

// 2026-10-15 is a Thursday; Sofia is UTC+3 until 2026-10-25 and UTC+2 after
const utc = (m: number, d: number, h: number, min = 0) => Date.UTC(2026, m - 1, d, h, min);

describe("expectedStatementDate: the previous weekday in Europe/Sofia, counted from 08:00 local", () => {
  const table: Array<[string, number, string]> = [
    ["Thursday 10:00 Sofia", utc(10, 15, 7), "2026-10-14"],
    [
      "Thursday 07:59 Sofia (before the daily run) counts as Wednesday",
      utc(10, 15, 4, 59),
      "2026-10-13",
    ],
    ["Thursday 08:00 Sofia", utc(10, 15, 5), "2026-10-14"],
    ["Monday 10:00 Sofia skips the weekend", utc(10, 19, 7), "2026-10-16"],
    ["Monday 07:00 Sofia", utc(10, 19, 4), "2026-10-16"],
    ["Saturday noon", utc(10, 17, 9), "2026-10-16"],
    ["Sunday noon", utc(10, 18, 9), "2026-10-16"],
    ["DST change day 2026-10-25, 05:00 UTC is 07:00 Sofia", utc(10, 25, 5), "2026-10-23"],
    ["DST change day 2026-10-25, 06:00 UTC is 08:00 Sofia", utc(10, 25, 6), "2026-10-23"],
    ["winter Tuesday 2026-12-15 10:00 Sofia", utc(12, 15, 8), "2026-12-14"],
  ];
  for (const [name, ms, expected] of table)
    it(name, () => expect(expectedStatementDate(ms)).toBe(expected));
});

describe("statementFreshness", () => {
  it("is current when the statement reaches the expected date, behind (with days) otherwise, unknown without a statement", () => {
    expect(statementFreshness("2026-10-14", "2026-10-14")).toEqual({ kind: "current" });
    expect(statementFreshness("2026-10-15", "2026-10-14")).toEqual({ kind: "current" });
    expect(statementFreshness("2026-10-13", "2026-10-14")).toEqual({ kind: "behind", days: 1 });
    expect(statementFreshness("2026-10-09", "2026-10-14")).toEqual({ kind: "behind", days: 5 });
    expect(statementFreshness(null, "2026-10-14")).toEqual({ kind: "unknown" });
  });
});

describe("dailySyncDue (spec 12.8): a new statement day is expected and Flex is not being hammered", () => {
  const base = {
    lastStatementDate: "2026-10-13",
    expected: "2026-10-14",
    nextFetchNotBeforeMs: null,
    nowMs: 1_000,
    hasActiveRun: false,
  };
  it("is due when the last statement is older than expected", () => {
    expect(dailySyncDue(base)).toBe(true);
    expect(dailySyncDue({ ...base, lastStatementDate: null })).toBe(true);
  });
  it("is not due when the statement is current, a run is active, or the 6 hour holiday back-off is running", () => {
    expect(dailySyncDue({ ...base, lastStatementDate: "2026-10-14" })).toBe(false);
    expect(dailySyncDue({ ...base, hasActiveRun: true })).toBe(false);
    expect(dailySyncDue({ ...base, nextFetchNotBeforeMs: 2_000 })).toBe(false);
    expect(dailySyncDue({ ...base, nextFetchNotBeforeMs: 1_000 })).toBe(true);
  });
});

describe("constants and disclosure text", () => {
  it("auto refresh is 5 minutes and the manual cooldown is 60 seconds", () => {
    expect(AUTO_REFRESH_MS).toBe(300_000);
    expect(MANUAL_COOLDOWN_S).toBe(60);
  });
  it("the T+1 disclosure is the exact spec text", () => {
    expect(t1Disclosure("2026-10-14")).toBe(
      "Positions, trades and cost basis come from your IBKR Activity Flex statement as of 2026-10-14 (end of day). Trades made today appear after IBKR builds tomorrow's statement. Prices shown are delayed Yahoo quotes.",
    );
    expect(t1Disclosure(null)).toContain("as of an unknown date");
  });
});
