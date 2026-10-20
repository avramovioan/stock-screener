import { describe, expect, it } from "vitest";
import type { Channel } from "./indicator.ts";
import {
  applicableDiscountLine,
  classifyHolding,
  discountTag,
  isDiscount,
  isPremium,
  lineEnd,
  lowerLinePositive,
  reachedLine4,
} from "./thresholds.ts";

const end = { base: 100, upper1: 110, upper2: 120, lower1: 90, lower2: 80 };
const channel = { end } as unknown as Channel;

describe("applicableDiscountLine (owner decision 2026-10-16: every rank triggers on the -3 line)", () => {
  it.each([1, 7, 10, 11, 40, 500, 0, -1, null] as const)("rank %s -> -3", (rank) => {
    expect(applicableDiscountLine(rank)).toBe("-3");
  });
});

describe("discountTag (rank decides only the tag)", () => {
  it("the top 10 are a strong buy whether or not they reached the -4 line", () => {
    expect(discountTag({ isTop10: true, reachedLine4: false })).toBe("strong_buy");
    expect(discountTag({ isTop10: true, reachedLine4: true })).toBe("strong_buy");
  });
  it("rank 11+ is tagged by depth: -4 reached, or wait for it", () => {
    expect(discountTag({ isTop10: false, reachedLine4: true })).toBe("reached_line4");
    expect(discountTag({ isTop10: false, reachedLine4: false })).toBe("wait_line4");
  });
});

describe("reachedLine4", () => {
  it("is close <= the -4 line end, equality qualifies", () => {
    expect(reachedLine4(80, end.lower2)).toBe(true);
    expect(reachedLine4(79, end.lower2)).toBe(true);
    expect(reachedLine4(85, end.lower2)).toBe(false);
  });
});

describe("lineEnd", () => {
  it("maps lines to the exact right-end values", () => {
    expect(lineEnd(channel, "-3")).toBe(90);
    expect(lineEnd(channel, "-4")).toBe(80);
    expect(lineEnd(channel, "+1")).toBe(110);
    expect(lineEnd(channel, "+2")).toBe(120);
  });
});

describe("level tests have no epsilon", () => {
  it("isDiscount: equality qualifies, one ulp above does not", () => {
    expect(isDiscount(90, 90)).toBe(true);
    expect(isDiscount(90 + Number.EPSILON * 128, 90)).toBe(false);
    expect(isDiscount(89.99, 90)).toBe(true);
  });
  it("isPremium: equality qualifies, one ulp below does not", () => {
    expect(isPremium(110, 110)).toBe(true);
    expect(isPremium(110 - Number.EPSILON * 128, 110)).toBe(false);
  });
});

describe("lowerLinePositive (zero-line rule)", () => {
  it("is false for 0 and -0.01, true for +0.01", () => {
    expect(lowerLinePositive(0)).toBe(false);
    expect(lowerLinePositive(-0)).toBe(false);
    expect(lowerLinePositive(-0.01)).toBe(false);
    expect(lowerLinePositive(0.01)).toBe(true);
  });
});

describe("classifyHolding", () => {
  const base = { evaluable: true, quoteType: "EQUITY", end, worldwideRank: null as number | null };
  it("precedence: extra_premium > premium > discounted > none", () => {
    expect(classifyHolding({ ...base, close: 125 })).toBe("extra_premium");
    expect(classifyHolding({ ...base, close: 115 })).toBe("premium");
    expect(classifyHolding({ ...base, close: 70 })).toBe("discounted");
    expect(classifyHolding({ ...base, close: 100 })).toBe("none");
  });
  it("a holding is discounted at or below the -3 line (90) whatever its rank, or none at all", () => {
    expect(classifyHolding({ ...base, close: 85, worldwideRank: null })).toBe("discounted");
    expect(classifyHolding({ ...base, close: 85, worldwideRank: 5 })).toBe("discounted");
    expect(classifyHolding({ ...base, close: 85, worldwideRank: 40 })).toBe("discounted");
    expect(classifyHolding({ ...base, close: 95, worldwideRank: 40 })).toBe("none");
  });
  it("is unavailable for non-equities, non-evaluable data and missing numbers", () => {
    expect(classifyHolding({ ...base, quoteType: "ETF", close: 70 })).toBe("unavailable");
    expect(classifyHolding({ ...base, evaluable: false, close: 70 })).toBe("unavailable");
    expect(classifyHolding({ ...base, close: null })).toBe("unavailable");
    expect(classifyHolding({ ...base, end: null, close: 70 })).toBe("unavailable");
  });
  it("never tags a discount when the applicable lower line is not positive", () => {
    const negative = { ...end, lower1: -1, lower2: -2 };
    expect(classifyHolding({ ...base, end: negative, close: -5, worldwideRank: 3 })).toBe("none");
  });
});

describe("classifyHolding with a non-finite channel end", () => {
  const base = { evaluable: true, quoteType: "EQUITY", close: 100, worldwideRank: 5 } as const;
  it("is unavailable when any channel end value is not finite", () => {
    expect(
      classifyHolding({
        ...base,
        end: { base: 100, upper1: Number.NaN, upper2: 120, lower1: 90, lower2: 80 },
      }),
    ).toBe("unavailable");
    expect(
      classifyHolding({
        ...base,
        end: { base: 100, upper1: 110, upper2: 120, lower1: Number.POSITIVE_INFINITY, lower2: 80 },
      }),
    ).toBe("unavailable");
  });
  it("still classifies a finite end", () => {
    expect(classifyHolding({ ...base, end })).not.toBe("unavailable");
  });
});
