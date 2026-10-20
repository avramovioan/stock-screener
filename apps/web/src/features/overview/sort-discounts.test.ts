import { describe, expect, it } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import { isCleared, sortDiscounts, splitDiscounts } from "./sort-discounts";

const sym = (rows: { yahoo_symbol: string }[]) => rows.map((r) => r.yahoo_symbol);

describe("sortDiscounts", () => {
  it("orders green before amber, then rank, then symbol", () => {
    const rows = [
      makeDiscount({ yahoo_symbol: "AMB1", operational_category: "amber", rank: 1 }),
      makeDiscount({ yahoo_symbol: "G5", rank: 5 }),
      makeDiscount({ yahoo_symbol: "G2B", rank: 2 }),
      makeDiscount({ yahoo_symbol: "G2A", rank: 2 }),
    ];
    expect(sym(sortDiscounts(rows))).toEqual(["G2A", "G2B", "G5", "AMB1"]);
  });
  it("is stable for identical keys and does not mutate its input", () => {
    const a = makeDiscount({ yahoo_symbol: "X", rank: 1, name: "first" });
    const b = makeDiscount({ yahoo_symbol: "X", rank: 1, name: "second" });
    const input = [a, b];
    expect(sortDiscounts(input).map((r) => r.name)).toEqual(["first", "second"]);
    expect(input[0]).toBe(a);
  });
});

describe("splitDiscounts", () => {
  const rows = [
    makeDiscount({ yahoo_symbol: "G", operational_category: "green" }),
    makeDiscount({ yahoo_symbol: "A", operational_category: "amber" }),
    makeDiscount({ yahoo_symbol: "R", operational_category: "red", withheld: true }),
    makeDiscount({ yahoo_symbol: "N", operational_category: "grey", withheld: true }),
    makeDiscount({ yahoo_symbol: "P", operational_category: "pending", withheld: true }),
    makeDiscount({ yahoo_symbol: "GW", operational_category: "green", withheld: true }),
    makeDiscount({ yahoo_symbol: "RX", operational_category: "red", withheld: false }),
  ];
  it("only green and amber, not withheld, are cards", () => {
    const { cards } = splitDiscounts(rows);
    expect(sym(cards)).toEqual(["G", "A"]);
  });
  it("everything else is withheld, including a green row flagged withheld and an inconsistent red row", () => {
    const { withheld } = splitDiscounts(rows);
    expect(sym(withheld).sort()).toEqual(["GW", "N", "P", "R", "RX"]);
  });
  it("isCleared mirrors the split", () => {
    expect(isCleared(rows[0] as never)).toBe(true);
    expect(isCleared(rows[2] as never)).toBe(false);
  });
});
