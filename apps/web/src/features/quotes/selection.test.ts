import { describe, expect, it } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import { optionLabel, pickSelection, selectionFromHit } from "./selection";

const msft = makeDiscount({
  rank: 53,
  yahoo_symbol: "MSFT",
  name: "Microsoft Corporation",
  security_id: "sid-msft",
  exchange_code: "NMS",
});
const asml = makeDiscount({
  rank: 12,
  yahoo_symbol: "ASML.AS",
  name: "ASML Holding",
  security_id: "sid-asml",
  exchange_code: "AMS",
});

describe("selection", () => {
  it("labels options #rank TICKER — Company", () => {
    expect(optionLabel(msft)).toBe("#53 MSFT — Microsoft Corporation");
  });
  it("labels a non-US option with the home ticker", () => {
    expect(optionLabel(asml)).toBe("#12 ASML — ASML Holding");
  });
  it("preselects by sid first, then by symbol (case-insensitive)", () => {
    expect(pickSelection([msft, asml], { sid: "sid-asml" })?.symbol).toBe("ASML.AS");
    expect(pickSelection([msft, asml], { symbol: "msft" })?.securityId).toBe("sid-msft");
  });
  it("a symbol outside today's list becomes a symbol-only selection", () => {
    expect(pickSelection([msft], { symbol: "aapl" })).toEqual({
      symbol: "AAPL",
      exchangeCode: null,
      name: null,
      securityId: null,
      rank: null,
    });
  });
  it("without params defaults to the first listed stock, or null when there are none", () => {
    expect(pickSelection([msft, asml], {})?.symbol).toBe("MSFT");
    expect(pickSelection([], {})).toBeNull();
  });
  it("a search hit becomes a symbol-only selection with its exchange", () => {
    expect(
      selectionFromHit({
        symbol: "asml.as",
        exchange: "AMS",
        quoteType: "EQUITY",
        longName: "ASML Holding N.V.",
        shortName: "ASML",
      }),
    ).toEqual({
      symbol: "ASML.AS",
      exchangeCode: "AMS",
      name: "ASML Holding N.V.",
      securityId: null,
      rank: null,
    });
  });
});
