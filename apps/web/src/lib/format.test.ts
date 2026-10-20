import { describe, expect, it } from "vitest";
import {
  decodeXmlEntities,
  formatCompactPrice,
  formatMarketCap,
  formatMoney,
  formatPct,
  formatPrice,
  formatRankTicker,
  formatSessionDate,
  formatSofia,
  homeTicker,
} from "./format";

describe("formatMoney", () => {
  it("formats a normal price with the currency code as text", () => {
    expect(formatMoney(412.5, "USD")).toBe("412.50 USD");
    expect(formatMoney(1234567.891, "EUR")).toBe("1,234,567.89 EUR");
  });
  it("keeps sub-unit precision for small prices", () => {
    expect(formatMoney(0.0123, "USD")).toBe("0.0123 USD");
  });
  it("shows a minor-unit price as quoted by default (GBp stays GBp)", () => {
    expect(formatMoney(1234.5, "GBp")).toBe("1,234.50 GBp");
  });
  it("converts a minor-unit price to the major currency when asked", () => {
    expect(formatMoney(1234, "GBp", { minor: true })).toBe("12.34 GBP");
    expect(formatMoney(1500, "KWF", { minor: true })).toBe("1.50 KWD");
    expect(formatMoney(55, "USD", { minor: true })).toBe("55.00 USD");
  });
  it("distinguishes zero from unavailable", () => {
    expect(formatMoney(0, "USD")).toBe("0.00 USD");
    expect(formatMoney(null, "USD")).toBe("n/a");
    expect(formatMoney(undefined, "USD")).toBe("n/a");
    expect(formatMoney(Number.NaN, "USD")).toBe("n/a");
  });
  it("formats negatives", () => {
    expect(formatMoney(-3.2, "USD")).toBe("-3.20 USD");
  });
});

describe("formatMarketCap", () => {
  it("abbreviates trillions, billions and millions with the currency", () => {
    expect(formatMarketCap(1.23e12, "USD")).toBe("1.23T USD");
    expect(formatMarketCap(456e9, "USD")).toBe("456B USD");
    expect(formatMarketCap(45.6e9, "USD")).toBe("45.6B USD");
    expect(formatMarketCap(5.25e9, "USD")).toBe("5.25B USD");
    expect(formatMarketCap(50e9, "USD")).toBe("50B USD");
    expect(formatMarketCap(222e9, "GBP")).toBe("222B GBP");
    expect(formatMarketCap(850e6, "EUR")).toBe("850M EUR");
  });
  it("handles huge values without scientific notation", () => {
    expect(formatMarketCap(1e15, "USD")).toBe("1000T USD");
  });
  it("handles zero, small and unavailable values", () => {
    expect(formatMarketCap(0, "USD")).toBe("0 USD");
    expect(formatMarketCap(950_000, "USD")).toBe("950,000 USD");
    expect(formatMarketCap(null, "USD")).toBe("n/a");
    expect(formatMarketCap(undefined, null)).toBe("n/a");
  });
  it("omits the currency when none is known", () => {
    expect(formatMarketCap(2e12, null)).toBe("2T");
  });
});

describe("formatCompactPrice", () => {
  it("uses the price symbol with T, B and M units", () => {
    expect(formatCompactPrice(5.34e12, "USD")).toBe("$5.34T");
    expect(formatCompactPrice(3.76e12, "HKD")).toBe("HK$3.76T");
    expect(formatCompactPrice(231e9, "EUR")).toBe("€231B");
    expect(formatCompactPrice(88e9, "CHF")).toBe("CHF 88B");
    expect(formatCompactPrice(850e6, "USD")).toBe("$850M");
    expect(formatCompactPrice(999.6e6, "USD")).toBe("$1B");
  });
  it("handles small, zero and unavailable values", () => {
    expect(formatCompactPrice(950_000, "USD")).toBe("$950,000");
    expect(formatCompactPrice(0, "EUR")).toBe("€0");
    expect(formatCompactPrice(null, "USD")).toBe("n/a");
    expect(formatCompactPrice(undefined, null)).toBe("n/a");
  });
  it("falls back to the code outside the table or without a currency", () => {
    expect(formatCompactPrice(88e9, "ILS")).toBe("88B ILS");
    expect(formatCompactPrice(2e12, null)).toBe("2T");
  });
  it.each([
    ["USD", "$"],
    ["EUR", "€"],
    ["GBP", "£"],
    ["JPY", "¥"],
    ["INR", "₹"],
    ["KRW", "₩"],
    ["BRL", "R$"],
    ["CHF", "CHF "],
    ["CNY", "CN¥"],
    ["HKD", "HK$"],
    ["CAD", "CA$"],
    ["AUD", "A$"],
    ["TWD", "NT$"],
    ["SGD", "S$"],
    ["SEK", "SEK "],
    ["NOK", "NOK "],
    ["DKK", "DKK "],
    ["MXN", "MX$"],
    ["SAR", "SAR "],
  ])("%s uses the formatPrice symbol", (ccy, prefix) => {
    expect(formatCompactPrice(12e9, ccy)).toBe(`${prefix}12B`);
    expect(formatPrice(1, ccy).startsWith(prefix)).toBe(true);
  });
});

describe("formatPct", () => {
  it("always shows an explicit sign for non-zero values", () => {
    expect(formatPct(1.234)).toBe("+1.23%");
    expect(formatPct(-0.5)).toBe("-0.50%");
  });
  it("shows zero and values that round to zero without a sign", () => {
    expect(formatPct(0)).toBe("0.00%");
    expect(formatPct(0.001)).toBe("0.00%");
    expect(formatPct(-0.001)).toBe("0.00%");
  });
  it("supports a digits argument and unavailable values", () => {
    expect(formatPct(12.34, 1)).toBe("+12.3%");
    expect(formatPct(null)).toBe("n/a");
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});

describe("formatSofia", () => {
  it("renders summer time (UTC+3)", () => {
    expect(formatSofia("2026-10-15T07:41:00Z")).toBe("15 Oct 2026, 10:41");
  });
  it("renders winter time (UTC+2)", () => {
    expect(formatSofia("2026-12-01T08:41:00Z")).toBe("1 Dec 2026, 10:41");
  });
  it("crosses midnight into the next Sofia day", () => {
    expect(formatSofia("2026-10-14T21:30:00Z")).toBe("15 Oct 2026, 00:30");
  });
  it("accepts epoch milliseconds and Date objects", () => {
    expect(formatSofia(Date.parse("2026-10-15T07:41:00Z"))).toBe("15 Oct 2026, 10:41");
    expect(formatSofia(new Date("2026-10-15T07:41:00Z"))).toBe("15 Oct 2026, 10:41");
  });
  it("can append the zone label and tolerates bad input", () => {
    expect(formatSofia("2026-10-15T07:41:00Z", { zoneLabel: true })).toBe(
      "15 Oct 2026, 10:41 (Europe/Sofia)",
    );
    expect(formatSofia(null)).toBe("n/a");
    expect(formatSofia("not a date")).toBe("n/a");
  });
});

describe("formatSessionDate", () => {
  it("formats a plain date without time-zone shifting", () => {
    expect(formatSessionDate("2026-10-14")).toBe("14 Oct 2026");
    expect(formatSessionDate("2026-01-02")).toBe("2 Jan 2026");
    expect(formatSessionDate("2026-10-25")).toBe("25 Oct 2026");
  });
  it("returns n/a for missing or malformed dates", () => {
    expect(formatSessionDate(null)).toBe("n/a");
    expect(formatSessionDate("14/10/2026")).toBe("n/a");
  });
});

describe("formatRankTicker", () => {
  it("renders #rank TICKER", () => {
    expect(formatRankTicker(53, "MSFT")).toBe("#53 MSFT");
  });
  it("falls back to the ticker when the rank is unknown", () => {
    expect(formatRankTicker(null, "MSFT")).toBe("MSFT");
  });
});

describe("homeTicker", () => {
  it("strips the Yahoo suffix on a non-US exchange and keeps US symbols", () => {
    expect(homeTicker("RMS.PA", "PAR")).toBe("RMS");
    expect(homeTicker("BRK-B", "NYQ")).toBe("BRK-B");
    expect(homeTicker("BRK.B", "NYQ")).toBe("BRK.B");
  });
  it("falls back to the listing country when the exchange code is unknown", () => {
    expect(homeTicker("BRK.B", null, "United States")).toBe("BRK.B");
    expect(homeTicker("ASML.AS", null, "Netherlands")).toBe("ASML");
  });
  it("leaves the symbol alone when neither the exchange nor the listing country is known", () => {
    expect(homeTicker("ASML.AS", null, null)).toBe("ASML.AS");
    expect(homeTicker("ASML.AS", undefined)).toBe("ASML.AS");
  });
});

describe("formatMarketCap unit boundaries", () => {
  it("steps up a unit when rounding reaches 1000", () => {
    expect(formatMarketCap(999.6e6, "USD")).toBe("1B USD");
    expect(formatMarketCap(999.4e6, "USD")).toBe("999M USD");
    expect(formatMarketCap(999.96e9, "USD")).toBe("1T USD");
    expect(formatMarketCap(999_999.6, "USD")).toBe("1M USD");
    expect(formatMarketCap(999_999.4, "USD")).toBe("999,999 USD");
    expect(formatMarketCap(-999.6e6, "USD")).toBe("-1B USD");
  });
});

describe("formatMoney negative zero", () => {
  it("never shows -0.00", () => {
    expect(formatMoney(-0.00001, "USD")).toBe("0.00 USD");
    expect(formatMoney(-0, "USD")).toBe("0.00 USD");
    expect(formatMoney(-0.004, "USD")).toBe("-0.004 USD");
  });
});

describe("formatSessionDate impossible dates", () => {
  it("rejects a date that does not exist", () => {
    expect(formatSessionDate("2026-02-30")).toBe("n/a");
    expect(formatSessionDate("2026-13-01")).toBe("n/a");
    expect(formatSessionDate("2026-02-28")).toBe("28 Feb 2026");
  });
});

describe("formatPrice", () => {
  const nb = "\u00a0";
  it("shows the currency symbol; only USD is a bare dollar", () => {
    const cases: [string, number, string][] = [
      ["USD", 242.5, "$242.50"],
      ["EUR", 380.25, "€380.25"],
      ["GBP", 12.3, "£12.30"],
      ["JPY", 3120, "¥3,120"],
      ["CHF", 88.1, `CHF${nb}88.10`],
      ["CNY", 45.6, "CN¥45.60"],
      ["HKD", 301.2, "HK$301.20"],
      ["CAD", 12, "CA$12.00"],
      ["AUD", 130.5, "A$130.50"],
      ["INR", 2450, "₹2,450.00"],
      ["KRW", 71000, "₩71,000"],
      ["TWD", 980, "NT$980.00"],
      ["SGD", 4.1, "S$4.10"],
      ["SEK", 250, `SEK${nb}250.00`],
      ["NOK", 410.5, `NOK${nb}410.50`],
      ["DKK", 700, `DKK${nb}700.00`],
      ["BRL", 36.2, "R$36.20"],
      ["MXN", 150, "MX$150.00"],
      ["SAR", 30.2, `SAR${nb}30.20`],
    ];
    for (const [ccy, v, text] of cases) expect(formatPrice(v, ccy)).toBe(text);
  });
  it("no two currencies share a symbol", () => {
    const ccys =
      "USD EUR GBP JPY CHF CNY HKD CAD AUD INR KRW TWD SGD SEK NOK DKK BRL MXN SAR".split(" ");
    const prefixes = ccys.map((c) => formatPrice(1, c).replace(/[\d.,\u00a0]+$/, ""));
    expect(new Set(prefixes).size).toBe(ccys.length);
  });
  it("keeps sub-unit precision, groups thousands and never prints a negative zero", () => {
    expect(formatPrice(0.0123, "USD")).toBe("$0.0123");
    expect(formatPrice(1234567.891, "EUR")).toBe("€1,234,567.89");
    expect(formatPrice(-0.000001, "USD")).toBe("$0.00");
    expect(formatPrice(-3.2, "USD")).toBe("-$3.20");
    expect(formatPrice(0, "USD")).toBe("$0.00");
  });
  it("GBp and unlisted currencies keep the code text of formatMoney", () => {
    expect(formatPrice(1234.5, "GBp")).toBe("1,234.50 GBp");
    expect(formatPrice(55, "ILS")).toBe("55.00 ILS");
  });
  it("converts a minor-unit price to the major currency symbol when asked", () => {
    expect(formatPrice(1234, "GBp", { minor: true })).toBe("£12.34");
  });
  it("is n/a without a number", () => {
    expect(formatPrice(null, "USD")).toBe("n/a");
    expect(formatPrice(undefined, "USD")).toBe("n/a");
    expect(formatPrice(Number.NaN, "USD")).toBe("n/a");
  });
});

describe("decodeXmlEntities", () => {
  it("decodes the five named entities and numeric references", () => {
    expect(decodeXmlEntities("VANG S&amp;P500 USDD")).toBe("VANG S&P500 USDD");
    expect(decodeXmlEntities("&lt;A&gt; &quot;b&quot; &apos;c&apos;")).toBe("<A> \"b\" 'c'");
    expect(decodeXmlEntities("&#38; &#x26; &#8364;")).toBe("& & €");
  });
  it("leaves plain text, unknown entities and null alone", () => {
    expect(decodeXmlEntities("APPLE INC")).toBe("APPLE INC");
    expect(decodeXmlEntities("A &nbsp; B")).toBe("A &nbsp; B");
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeXmlEntities(null)).toBe("");
  });
});
