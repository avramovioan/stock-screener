import { describe, expect, it } from "vitest";
import { type HoldingResult, tagFor } from "./holding-tag.ts";

const END = { upper2: 140, upper1: 120, base: 100, lower1: 85, lower2: 70 };
const result = (o: Partial<HoldingResult> = {}): HoldingResult => ({
  securityId: "s1",
  status: "processed",
  sessionDate: "2026-10-14",
  close: 100,
  channel: { end: END },
  quoteType: "EQUITY",
  companyId: "co1",
  ...o,
});

describe("tagFor", () => {
  it("Discounted at or below the -3 line, Premium at +1, Extra premium at +2, none in between", () => {
    expect(tagFor(result({ close: 85 }), null).tag).toBe("discounted");
    expect(tagFor(result({ close: 84.99 }), null).tag).toBe("discounted");
    expect(tagFor(result({ close: 85.01 }), null).tag).toBe("none");
    expect(tagFor(result({ close: 120 }), null).tag).toBe("premium");
    expect(tagFor(result({ close: 140 }), null).tag).toBe("extra_premium");
    expect(tagFor(result({ close: 100 }), null).tag).toBe("none");
  });

  it("Unavailable without a channel, without usable data, for a non-equity or without a result", () => {
    expect(tagFor(result({ channel: null }), null).tag).toBe("unavailable");
    expect(tagFor(result({ status: "insufficient_data" }), null).tag).toBe("unavailable");
    expect(tagFor(result({ status: "stale" }), null).tag).toBe("unavailable");
    expect(tagFor(result({ quoteType: "ETF", close: 50 }), null).tag).toBe("unavailable");
    expect(tagFor(undefined, null)).toEqual({
      tag: "unavailable",
      reason: "no scan result for this security",
      sessionDate: null,
    });
  });

  it("every holding uses the -3 line whatever its rank; a zero lower line is never a discount", () => {
    expect(tagFor(result({ close: 80 }), null).tag).toBe("discounted");
    expect(tagFor(result({ close: 80 }), 11).tag).toBe("discounted");
    expect(tagFor(result({ close: 80 }), 7).tag).toBe("discounted");
    expect(tagFor(result({ close: 90 }), 40).tag).toBe("none");
    expect(tagFor(result({ close: 0, channel: { end: { ...END, lower1: 0 } } }), null).tag).toBe(
      "none",
    );
  });

  it("explains its basis with the session date of the completed close", () => {
    const t = tagFor(result({ close: 70 }), null);
    expect(t.sessionDate).toBe("2026-10-14");
    expect(t.reason).toBe("based on close of 2026-10-14");
  });
});
