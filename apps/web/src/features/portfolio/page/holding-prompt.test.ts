import { describe, expect, it } from "vitest";
import { buildHoldingPrompt } from "./holding-prompt";
import type { HoldingLink } from "./holdings-api";
import { makeRow } from "./test-fixtures";

const screened: HoldingLink = {
  conid: 100001,
  securityId: "sec-aapl",
  symbol: "AAPL",
  monitor: null,
  held: {
    symbol: "AAPL",
    listingExchange: "NASDAQ",
    conid: 100001,
    description: "APPLE INC",
    currency: "USD",
  },
  screened: { exchangeCode: "NMS", exchangeName: "NASDAQ", rank: 4 },
};

describe("buildHoldingPrompt", () => {
  it("names the holding, its listing, last price and date, and says the lines are not available", () => {
    const text = buildHoldingPrompt(makeRow(), screened);
    expect(text).toContain("- Name: APPLE INC");
    expect(text).toContain("- Ticker: AAPL (Yahoo AAPL)");
    expect(text).toContain("- Exchange: NASDAQ");
    expect(text).toContain("- Last close: $232.00 on 15 Oct 2026");
    expect(text).toContain("The −3/−4 line levels are not available for this holding");
    expect(text).not.toContain("the −3 line is at");
    expect(text).toContain("Is the stock falling for temporary reasons");
  });

  it("an unscreened holding uses its statement symbol and decodes the description", () => {
    const row = makeRow({ ticker: "VUAA", name: "VANG S&amp;P500 USDD", currency: "USD" });
    const text = buildHoldingPrompt(row, undefined);
    expect(text).toContain("- Name: VANG S&P500 USDD");
    expect(text).toContain("- Ticker: VUAA");
  });

  it("uses the statement close date when there is no delayed quote", () => {
    const row = makeRow({
      price: {
        value: 24.31,
        ccy: "GBP",
        source: { kind: "statement_close", reportDate: "2026-10-14", reason: "no delayed quote" },
        note: null,
      },
      quoteTime: null,
      currency: "GBP",
    });
    expect(buildHoldingPrompt(row, undefined)).toContain("- Last close: £24.31 on 14 Oct 2026");
  });

  it("a holding without a price says the price is unknown, never zero", () => {
    const row = makeRow({
      price: {
        value: null,
        ccy: "USD",
        source: { kind: "unavailable", reason: "no price" },
        note: null,
      },
      quoteTime: null,
    });
    const text = buildHoldingPrompt(row, undefined);
    expect(text).toContain("- Last close: not available for this holding");
    expect(text).not.toContain("0.00");
  });
});
