import { describe, expect, it } from "vitest";
import { validateRegulatedSearch } from "./search-params";

describe("validateRegulatedSearch", () => {
  it("keeps a valid isin and mic, upper-cased", () => {
    expect(validateRegulatedSearch({ isin: "ie00bmfkg444", mic: "xetr" })).toEqual({
      isin: "IE00BMFKG444",
      mic: "XETR",
    });
  });
  it("drops invalid values instead of throwing", () => {
    expect(validateRegulatedSearch({ isin: "x".repeat(20), mic: "TOOLONG" })).toEqual({});
    expect(validateRegulatedSearch({ isin: 5, mic: "<b>" })).toEqual({});
    expect(validateRegulatedSearch({})).toEqual({});
  });
});
