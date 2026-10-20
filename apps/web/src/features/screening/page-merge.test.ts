import { describe, expect, it } from "vitest";
import { nextAfterRank, PAGE_FIRST, PAGE_NEXT, pageMerge } from "./page-merge";
import type { CompanyListRow } from "./types";

function row(rank: number, total: number): CompanyListRow {
  return {
    rank,
    company_id: `c${rank}`,
    security_id: `s${rank}`,
    yahoo_symbol: `T${rank}`,
    name: `Company ${rank}`,
    currency: "USD",
    last_close: 10,
    prev_close: 9,
    change_pct: 11.11,
    session_date: "2026-10-14",
    price_freshness: "fresh",
    market_cap_usd: 1e9,
    market_cap_native: 1e9,
    market_cap_ccy: "USD",
    is_top10: rank <= 10,
    applicable_line: null,
    lower_line_positive: null,
    is_discount: false,
    state: "member",
    total_count: total,
    country: "United States",
    listing_country: "United States",
  };
}
const range = (from: number, to: number, total: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(from + i, total));

describe("page sizes", () => {
  it("is 15 first then 25", () => {
    expect(PAGE_FIRST).toBe(15);
    expect(PAGE_NEXT).toBe(25);
  });
});

describe("pageMerge", () => {
  it("concatenates pages in rank order", () => {
    const merged = pageMerge([range(1, 15, 60), range(16, 40, 45)]);
    expect(merged).toHaveLength(40);
    expect(merged[0]?.rank).toBe(1);
    expect(merged[39]?.rank).toBe(40);
  });
  it("drops duplicate ranks (a refetch can overlap) and keeps ascending order", () => {
    const merged = pageMerge([range(1, 15, 60), range(13, 20, 47)]);
    expect(merged.map((r) => r.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  it("handles no pages and empty pages", () => {
    expect(pageMerge([])).toEqual([]);
    expect(pageMerge([[]])).toEqual([]);
  });
});

describe("nextAfterRank", () => {
  it("returns the last rank while rows remain after the cursor", () => {
    const first = range(1, 15, 60); // total_count = rows after the cursor (all 60)
    expect(nextAfterRank(first)).toBe(15);
  });
  it("returns undefined when the page exhausted the list", () => {
    expect(nextAfterRank(range(16, 40, 25))).toBeUndefined();
    expect(nextAfterRank(range(1, 15, 15))).toBeUndefined();
  });
  it("returns undefined for an empty page", () => {
    expect(nextAfterRank([])).toBeUndefined();
  });
});
