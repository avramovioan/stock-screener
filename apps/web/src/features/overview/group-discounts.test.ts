import { describe, expect, it } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import { evaluatedSentence, overviewSentence } from "./overview-heading";
import { groupDiscounts } from "./sort-discounts";

const sym = (rows: { yahoo_symbol: string }[]) => rows.map((r) => r.yahoo_symbol);

describe("groupDiscounts", () => {
  const pending = { operational_category: "pending", category_reason: "research_pending" } as const;

  it("grid: cleared, caution, pending by rank; flagged apart", () => {
    const { cards, flagged } = groupDiscounts([
      makeDiscount({ yahoo_symbol: "P3", rank: 3, withheld: true, ...pending }),
      makeDiscount({ yahoo_symbol: "A9", rank: 9, operational_category: "amber" }),
      makeDiscount({ yahoo_symbol: "G8", rank: 8 }),
      makeDiscount({ yahoo_symbol: "G1", rank: 1 }),
      makeDiscount({ yahoo_symbol: "P1", rank: 1, withheld: true, ...pending }),
      makeDiscount({ yahoo_symbol: "R2", rank: 2, operational_category: "red", withheld: true }),
      makeDiscount({ yahoo_symbol: "X5", rank: 5, operational_category: "grey", withheld: true }),
      makeDiscount({ yahoo_symbol: "A4", rank: 4, operational_category: "amber" }),
    ]);
    expect(sym(cards)).toEqual(["G1", "G8", "A4", "A9", "P1", "P3"]);
    expect(sym(flagged)).toEqual(["R2", "X5"]);
  });

  it("all is the one grid: the cards, then the flagged ones last", () => {
    const { all } = groupDiscounts([
      makeDiscount({ yahoo_symbol: "R2", rank: 2, operational_category: "red", withheld: true }),
      makeDiscount({ yahoo_symbol: "G8", rank: 8 }),
      makeDiscount({ yahoo_symbol: "G1", rank: 1 }),
    ]);
    expect(sym(all)).toEqual(["G1", "G8", "R2"]);
  });

  it("a withheld green row is flagged, not a card", () => {
    const { cards, flagged } = groupDiscounts([
      makeDiscount({ yahoo_symbol: "W", withheld: true, category_reason: "held" }),
    ]);
    expect(cards).toEqual([]);
    expect(sym(flagged)).toEqual(["W"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      makeDiscount({ yahoo_symbol: "B", rank: 2 }),
      makeDiscount({ yahoo_symbol: "A" }),
    ];
    groupDiscounts(rows);
    expect(sym(rows)).toEqual(["B", "A"]);
  });
});

describe("overview sentences", () => {
  it("all countries: zero, one, many", () => {
    expect(overviewSentence("all", 0)).toBe("No companies closed at or below their −3 line today.");
    expect(overviewSentence("all", 1)).toBe("1 company closed at or below its −3 line.");
    expect(overviewSentence("all", 3)).toBe("3 companies closed at or below their −3 line.");
  });
  it("US filter: zero, one, many", () => {
    expect(overviewSentence("us", 0)).toBe(
      "No US companies closed at or below their −3 line today.",
    );
    expect(overviewSentence("us", 1)).toBe("1 US company closed at or below its −3 line.");
    expect(overviewSentence("us", 2)).toBe("2 US companies closed at or below their −3 line.");
  });
  it("names how many are at the −4 line, and drops the clause at zero", () => {
    expect(overviewSentence("all", 3, 1)).toBe(
      "3 companies closed at or below their −3 line, 1 of them at its −4 line.",
    );
    expect(overviewSentence("all", 4, 3)).toBe(
      "4 companies closed at or below their −3 line, 3 of them at their −4 line.",
    );
    expect(overviewSentence("us", 2, 2)).toBe(
      "2 US companies closed at or below their −3 line, 2 of them at their −4 line.",
    );
    expect(overviewSentence("all", 1, 1)).toBe(
      "1 company closed at or below its −3 line, at its −4 line.",
    );
    expect(overviewSentence("all", 3, 0)).toBe("3 companies closed at or below their −3 line.");
  });
  it("the evaluated sentence names the market cap rule", () => {
    expect(evaluatedSentence(451, 640)).toBe(
      "451 of 640 companies worth US$50B or more were evaluated.",
    );
  });
});
