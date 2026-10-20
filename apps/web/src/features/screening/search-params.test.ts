import { describe, expect, it } from "vitest";
import { validateOverviewSearch, validateQuotesSearch } from "./search-params";

describe("validateOverviewSearch", () => {
  it("keeps country=us", () => {
    expect(validateOverviewSearch({ country: "us" })).toEqual({ country: "us" });
  });
  it("leaves country undefined when missing or invalid, never throws", () => {
    expect(validateOverviewSearch({}).country).toBeUndefined();
    expect(validateOverviewSearch({ country: "mars" }).country).toBeUndefined();
    expect(validateOverviewSearch({ country: "all" }).country).toBeUndefined();
    expect(validateOverviewSearch({ country: 5 }).country).toBeUndefined();
    expect(validateOverviewSearch({ country: ["us", "de"] }).country).toBeUndefined();
  });
  it("ignores the retired ?mode= parameter", () => {
    expect(validateOverviewSearch({ mode: "worldwide" })).toEqual({});
    expect(validateOverviewSearch({ mode: "us", country: "us" })).toEqual({ country: "us" });
  });
});

describe("validateQuotesSearch", () => {
  it("keeps a valid Yahoo symbol and sid, and drops the retired mode", () => {
    const sid = "3f2b8c1e-5a47-4c0e-9d2b-1a2b3c4d5e6f";
    expect(validateQuotesSearch({ symbol: "0700.HK", sid, mode: "us" })).toEqual({
      symbol: "0700.HK",
      sid,
    });
    expect(validateQuotesSearch({ symbol: "BRK-B" }).symbol).toBe("BRK-B");
  });
  it("drops malformed values instead of failing the route", () => {
    expect(validateQuotesSearch({ symbol: "<script>" }).symbol).toBeUndefined();
    expect(validateQuotesSearch({ symbol: "" }).symbol).toBeUndefined();
    expect(validateQuotesSearch({ symbol: "A".repeat(41) }).symbol).toBeUndefined();
    expect(validateQuotesSearch({ sid: "not-a-uuid" }).sid).toBeUndefined();
  });
});
