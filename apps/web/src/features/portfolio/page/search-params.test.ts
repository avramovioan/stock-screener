import { describe, expect, it } from "vitest";
import { filtersFromSearch, searchFromFilters, validatePortfolioSearch } from "./search-params";
import { NO_FILTERS } from "./trades-api";

describe("portfolio search params", () => {
  it("keeps valid filters and drops invalid ones, never throwing", () => {
    expect(
      validatePortfolioSearch({
        q: " MSFT ",
        type: "fx",
        side: "SELL",
        ccy: "usd",
        from: "2026-01-01",
        to: "2026-10-19",
      }),
    ).toEqual({
      q: "MSFT",
      type: "fx",
      side: "SELL",
      ccy: "USD",
      from: "2026-01-01",
      to: "2026-10-19",
    });
    expect(
      validatePortfolioSearch({
        q: 5,
        type: "crypto",
        side: "HOLD",
        ccy: "dollars",
        from: "x",
        to: "2026-02-30",
      }),
    ).toEqual({});
    expect(validatePortfolioSearch({})).toEqual({});
  });

  it("maps search to filters and back; defaults are not written to the address", () => {
    expect(filtersFromSearch({})).toEqual(NO_FILTERS);
    expect(filtersFromSearch({ q: "AAPL", side: "BUY", type: "bonds" })).toEqual({
      ...NO_FILTERS,
      q: "AAPL",
      side: "BUY",
      type: "bonds",
    });
    expect(searchFromFilters(NO_FILTERS)).toEqual({});
    expect(searchFromFilters({ ...NO_FILTERS, q: "AAPL", ccy: "USD" })).toEqual({
      q: "AAPL",
      ccy: "USD",
    });
  });
});
