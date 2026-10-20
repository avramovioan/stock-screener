import { describe, expect, it } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import {
  cardState,
  discountTag,
  flagLabel,
  flagTone,
  formatPercentBelow,
  gaugeFacts,
  gaugeScale,
  labelsMerge,
  lineName,
  percentBelow,
  verdictTag,
} from "./card-state";
import { researchView } from "./research-state";

describe("cardState", () => {
  it("maps the four states", () => {
    expect(cardState(makeDiscount())).toBe("cleared");
    expect(cardState(makeDiscount({ operational_category: "amber" }))).toBe("caution");
    expect(cardState(makeDiscount({ operational_category: "pending", withheld: true }))).toBe(
      "pending",
    );
    expect(cardState(makeDiscount({ operational_category: "red", withheld: true }))).toBe(
      "flagged",
    );
    expect(cardState(makeDiscount({ operational_category: "grey", withheld: true }))).toBe(
      "flagged",
    );
  });
  it("a pending or deferred reason is pending unless the row is red or grey", () => {
    expect(
      cardState(
        makeDiscount({ operational_category: "amber", category_reason: "research_pending" }),
      ),
    ).toBe("pending");
    expect(
      cardState(
        makeDiscount({ operational_category: "green", category_reason: "research_quota_deferred" }),
      ),
    ).toBe("pending");
    expect(
      cardState(
        makeDiscount({
          operational_category: "grey",
          category_reason: "research_pending",
          withheld: true,
        }),
      ),
    ).toBe("flagged");
  });
  it("a green or amber row that is withheld for another reason is flagged, never cleared", () => {
    expect(
      cardState(
        makeDiscount({ operational_category: "green", withheld: true, category_reason: "held" }),
      ),
    ).toBe("flagged");
    expect(
      cardState(
        makeDiscount({ operational_category: "amber", withheld: true, category_reason: "held" }),
      ),
    ).toBe("flagged");
  });
});

describe("flag labels", () => {
  it("names the reason, with a fallback per category", () => {
    expect(flagLabel(makeDiscount({ category_reason: "bankruptcy_high" }))).toBe(
      "High bankruptcy risk",
    );
    expect(flagLabel(makeDiscount({ category_reason: "inconclusive" }))).toBe("Inconclusive");
    expect(flagLabel(makeDiscount({ category_reason: "research_failed" }))).toBe("Research failed");
    expect(flagLabel(makeDiscount({ category_reason: "x", operational_category: "red" }))).toBe(
      "Not cleared",
    );
    expect(flagLabel(makeDiscount({ category_reason: "x", operational_category: "grey" }))).toBe(
      "Inconclusive",
    );
    expect(flagLabel(makeDiscount({ category_reason: "x", operational_category: "green" }))).toBe(
      "Withheld",
    );
  });
  it("only red rows use the red tone", () => {
    expect(flagTone(makeDiscount({ operational_category: "red" }))).toBe("red");
    expect(flagTone(makeDiscount({ operational_category: "grey" }))).toBe("grey");
    expect(flagTone(makeDiscount({ operational_category: "green" }))).toBe("grey");
  });
});

describe("percentBelow", () => {
  it("is (line end - close) / line end in percent", () => {
    expect(percentBelow(242.5, 247.3)).toBeCloseTo(1.9409, 3);
    expect(percentBelow(95, 100)).toBe(5);
  });
  it("rounds to one decimal for display", () => {
    expect(formatPercentBelow(1.94)).toBe("1.9");
    expect(formatPercentBelow(1.96)).toBe("2.0");
    expect(formatPercentBelow(0)).toBe("0.0");
    expect(formatPercentBelow(12.349)).toBe("12.3");
  });
  it("never goes negative and rejects an unusable line", () => {
    expect(percentBelow(105, 100)).toBe(0);
    expect(percentBelow(10, 0)).toBeNull();
    expect(percentBelow(10, Number.NaN)).toBeNull();
  });
});

const MCD = {
  close: 242.5,
  line3_end: 266.14,
  line4_end: 247.3,
  reached_line4: true,
  is_top10: false,
  rank: 101,
};
const AON = {
  close: 286.8,
  line3_end: 307.55,
  line4_end: 280.99,
  reached_line4: false,
  is_top10: false,
  rank: 333,
};

describe("discountTag", () => {
  it("is never Strong buy: a top 10 card reads Reached or Wait like any other", () => {
    expect(discountTag(makeDiscount({ ...MCD, is_top10: true }))).toBe("reached");
    expect(discountTag(makeDiscount({ ...AON, is_top10: true }))).toBe("wait");
  });
  it("outside the top 10: Reached at the −4 line, otherwise Wait", () => {
    expect(discountTag(makeDiscount(MCD))).toBe("reached");
    expect(discountTag(makeDiscount(AON))).toBe("wait");
  });
  it("flagged cards carry the same factual tag as any other card", () => {
    for (const category of ["red", "grey"] as const) {
      expect(
        discountTag(makeDiscount({ ...MCD, operational_category: category, withheld: true })),
      ).toBe("reached");
      expect(
        discountTag(makeDiscount({ ...AON, operational_category: category, withheld: true })),
      ).toBe("wait");
    }
    expect(discountTag(makeDiscount({ ...MCD, is_top10: true, withheld: true }))).toBe("reached");
  });
  it("pending and caution cards are tagged", () => {
    expect(discountTag(makeDiscount({ ...AON, operational_category: "pending" }))).toBe("wait");
    expect(discountTag(makeDiscount({ ...AON, operational_category: "amber" }))).toBe("wait");
  });
});

describe("verdictTag", () => {
  const NOW = new Date("2026-10-19T12:00:00Z");
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
  const DAY = 24 * 60;
  const done = { research_completed_at: ago(60) };
  const notScanned = {
    operational_category: "pending",
    withheld: true,
    research_completed_at: null,
  } as const;
  const tag = (over: Parameters<typeof makeDiscount>[0]) => {
    const row = makeDiscount(over);
    return verdictTag(row, researchView(row, NOW));
  };

  it.each([
    ["MCD-like: rank 97, reached −4, green", { ...MCD, rank: 97, ...done }, "strong"],
    ["top 10 green, only −3", { ...AON, is_top10: true, rank: 4, ...done }, "strong"],
    ["rank 114, only −3, green", { ...AON, rank: 114, ...done }, "consider"],
    [
      "amber top 10 is capped at Consider",
      { is_top10: true, operational_category: "amber", ...done },
      "consider",
    ],
    ["amber at −4 is Consider", { ...MCD, operational_category: "amber", ...done }, "consider"],
    ["red is Avoid", { operational_category: "red", withheld: true, ...done }, "avoid"],
    ["grey is Avoid", { operational_category: "grey", withheld: true, ...done }, "avoid"],
    ["withheld green is Avoid", { withheld: true, ...done }, "avoid"],
    ["not scanned is Unchecked", notScanned, "unchecked"],
    [
      "a 31 day old green report is Unchecked",
      { ...MCD, research_completed_at: ago(31 * DAY) },
      "unchecked",
    ],
    [
      "running is Unchecked",
      { ...MCD, ...done, research_started_at: ago(1), research_requested_by: "visitor" },
      "unchecked",
    ],
    [
      "paused is Unchecked",
      {
        ...MCD,
        ...done,
        research_started_at: ago(30),
        research_wait_reason: "llm_quota",
        research_requested_by: "owner",
      },
      "unchecked",
    ],
    [
      "failed (busy) is Unchecked",
      { ...notScanned, research_failed_at: ago(5), research_failed_reason: "providers_busy" },
      "unchecked",
    ],
    [
      "failed (no quota) is Unchecked",
      { ...notScanned, research_failed_at: ago(5), research_failed_reason: "no_quota" },
      "unchecked",
    ],
  ] as const)("%s", (_name, over, expected) => {
    expect(tag(over as Parameters<typeof makeDiscount>[0])).toBe(expected);
  });
});

describe("gaugeScale", () => {
  it("pads 15% of the line gap past the outermost value (MCD: close below −4)", () => {
    const x = gaugeScale(242.5, 266.14, 247.3);
    expect(x.close).toBeCloseTo(9.65, 1);
    expect(x.line4).toBeCloseTo(26, 0);
    expect(x.line3).toBeCloseTo(90.35, 1);
  });
  it("close between the lines: the lines sit at 11.5% and 88.5%", () => {
    const x = gaugeScale(100, 110, 90);
    expect(x.line4).toBeCloseTo(11.54, 1);
    expect(x.line3).toBeCloseTo(88.46, 1);
    expect(x.close).toBeCloseTo(50, 5);
  });
  it("close at the −3 line: the close dot sits on its marker", () => {
    const x = gaugeScale(110, 110, 90);
    expect(x.close).toBeCloseTo(x.line3, 5);
  });
});

describe("labelsMerge", () => {
  it("merges when the markers are less than 12 points apart", () => {
    expect(labelsMerge(90, 79)).toBe(true);
    expect(labelsMerge(90, 78)).toBe(false);
    expect(labelsMerge(88.5, 11.5)).toBe(false);
  });
  it("a far-below close with close lines does merge", () => {
    const x = gaugeScale(60, 110, 105);
    expect(labelsMerge(x.line3, x.line4)).toBe(true);
  });
});

describe("gaugeFacts", () => {
  it("MCD: below −4 prints both percentages, prices with the currency symbol", () => {
    const facts = gaugeFacts(makeDiscount({ ...MCD, currency: "USD" }));
    expect(facts).toMatchObject({
      below3: "8.9",
      below4: "1.9",
      closeText: "$242.50",
      line3Price: "$266.14",
      line4Price: "$247.30",
      merged: false,
    });
    expect(facts?.ariaLabel).toBe(
      "Close is 8.9% below its −3 line of $266.14 and 1.9% below its −4 line of $247.30",
    );
  });
  it("AON: between the lines, −4 is N% lower, rounded to one decimal", () => {
    const facts = gaugeFacts(makeDiscount({ ...AON, currency: "USD" }));
    expect(facts).toMatchObject({ below3: "6.7", below4: null, lower4: "2.0" });
    expect(facts?.ariaLabel).toBe(
      "Close is 6.7% below its −3 line of $307.55. The −4 line, $280.99, is 2.0% lower",
    );
  });
  it("rounds to one decimal", () => {
    expect(gaugeFacts(makeDiscount({ close: 99.93, line3_end: 100, line4_end: 90 }))?.below3).toBe(
      "0.1",
    );
    expect(gaugeFacts(makeDiscount({ close: 99.96, line3_end: 100, line4_end: 90 }))?.below3).toBe(
      "0.0",
    );
  });
  it("is null without usable lines, or when the −4 line is not below the −3 line", () => {
    expect(gaugeFacts(makeDiscount({ line3_end: 0 }))).toBeNull();
    expect(gaugeFacts(makeDiscount({ line4_end: Number.NaN }))).toBeNull();
    expect(gaugeFacts(makeDiscount({ line3_end: 100, line4_end: 100 }))).toBeNull();
  });
  it("lineName replaces the hyphen only", () => {
    expect(lineName("-3")).toBe("−3");
    expect(lineName("+1")).toBe("+1");
  });
});
