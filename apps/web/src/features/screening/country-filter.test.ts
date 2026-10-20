import { describe, expect, it } from "vitest";
import { countryFilterFromSearch, filterByCountry, matchesCountry } from "./country-filter";

describe("country filter", () => {
  it("all keeps everything, including an unknown country", () => {
    expect(matchesCountry("Japan", "all")).toBe(true);
    expect(matchesCountry(null, "all")).toBe(true);
  });
  it("us keeps United States only", () => {
    expect(matchesCountry("United States", "us")).toBe(true);
    expect(matchesCountry("Japan", "us")).toBe(false);
    expect(matchesCountry(null, "us")).toBe(false);
    expect(matchesCountry(undefined, "us")).toBe(false);
  });
  it("filterByCountry preserves order", () => {
    const rows = [
      { id: 1, listing_country: "United States" },
      { id: 2, listing_country: "Japan" },
      { id: 3, listing_country: "United States" },
    ];
    expect(filterByCountry(rows, "us").map((r) => r.id)).toEqual([1, 3]);
    expect(filterByCountry(rows, "all")).toHaveLength(3);
  });
  it("?country=us is the US filter, anything else is all", () => {
    expect(countryFilterFromSearch({ country: "us" })).toBe("us");
    expect(countryFilterFromSearch({})).toBe("all");
  });
});
