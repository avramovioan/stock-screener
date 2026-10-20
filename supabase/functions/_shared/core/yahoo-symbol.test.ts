import { describe, expect, it } from "vitest";
import { yahooSymbolForHolding } from "./yahoo-symbol.ts";

describe("yahooSymbolForHolding", () => {
  it("returns null for bonds and symbols with a space", () => {
    expect(yahooSymbolForHolding("XS1234", "AEB", "BOND")).toBeNull();
    expect(yahooSymbolForHolding("T 4.5 05/15/30", "NYSE", "STK")).toBeNull();
  });

  it("keeps US symbols and maps dots to dashes", () => {
    for (const ex of ["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS", "NYSENAT"]) {
      expect(yahooSymbolForHolding("AAPL", ex, "STK")).toBe("AAPL");
    }
    expect(yahooSymbolForHolding("BRK.B", "NYSE", "STK")).toBe("BRK-B");
  });

  it("appends the Yahoo suffix per exchange", () => {
    const cases: Array<[string, string]> = [
      ["AEB", ".AS"],
      ["IBIS", ".DE"],
      ["IBIS2", ".DE"],
      ["LSE", ".L"],
      ["LSEETF", ".L"],
      ["SBF", ".PA"],
      ["EBS", ".SW"],
      ["BVME", ".MI"],
      ["BME", ".MC"],
      ["SFB", ".ST"],
      ["CPH", ".CO"],
      ["HEX", ".HE"],
      ["TSE", ".TO"],
      ["ASX", ".AX"],
      ["SEHK", ".HK"],
    ];
    for (const [ex, suffix] of cases) {
      expect(yahooSymbolForHolding("VUSA", ex, "ETF")).toBe(`VUSA${suffix}`);
    }
  });

  it("trims and upper-cases the exchange code", () => {
    expect(yahooSymbolForHolding("VUSA", " aeb ", "ETF")).toBe("VUSA.AS");
  });

  it("returns null for unknown or missing exchange", () => {
    expect(yahooSymbolForHolding("XYZ", "NOPE", "STK")).toBeNull();
    expect(yahooSymbolForHolding("XYZ", null, null)).toBeNull();
  });
});
