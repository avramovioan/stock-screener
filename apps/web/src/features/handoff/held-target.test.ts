import { describe, expect, it } from "vitest";
import { deriveHeldHandoff } from "./derive";
import { heldDestination } from "./held-destination";
import { holdingTarget } from "./holding-target";
import { type HeldTarget, isHeldTarget } from "./types";

const VUAA: HeldTarget = {
  kind: "held",
  symbol: "VUAA",
  listingExchange: "LSEETF",
  conid: 123456,
  description: "VANG S&P500 USDD",
  currency: "USD",
};
const form = (over: Record<string, unknown> = {}) => ({
  side: "buy" as const,
  orderType: "limit" as const,
  quantityText: "5",
  priceText: "112.84",
  destination: null,
  acknowledged: false,
  manualSymbol: "",
  ...over,
});

describe("holdingTarget held mode", () => {
  it("an unscreened holding targets the held instrument from the statement", () => {
    const t = holdingTarget({
      canonicalSecurityId: null,
      canonicalSymbol: null,
      companyName: "VANG S&P500 USDD",
      held: {
        symbol: "VUAA",
        listingExchange: "LSEETF",
        conid: 123456,
        description: "VANG S&P500 USDD",
        currency: "USD",
      },
    });
    expect(t).toEqual(VUAA);
    expect(t !== null && isHeldTarget(t)).toBe(true);
  });

  it("a screened holding keeps the canonical listing even when held data is present", () => {
    const t = holdingTarget({
      canonicalSecurityId: "sec-msft",
      canonicalSymbol: "MSFT",
      companyName: "Microsoft",
      held: {
        symbol: "MSFT",
        listingExchange: "NASDAQ",
        conid: 1,
        description: null,
        currency: "USD",
      },
    });
    expect(t).toMatchObject({ securityId: "sec-msft", symbol: "MSFT", rank: null });
    expect(t !== null && isHeldTarget(t)).toBe(false);
  });
});

describe("heldDestination", () => {
  it("keeps a known IBKR destination and falls back to SMART otherwise", () => {
    expect(heldDestination("LSEETF")).toEqual({ destination: "LSEETF", fallback: false });
    expect(heldDestination("nasdaq")).toEqual({ destination: "NASDAQ", fallback: false });
    expect(heldDestination("XYZQ")).toEqual({ destination: "SMART", fallback: true });
    expect(heldDestination(null)).toEqual({ destination: "SMART", fallback: true });
    expect(heldDestination("")).toEqual({ destination: "SMART", fallback: true });
  });
});

describe("deriveHeldHandoff", () => {
  it("builds the iBot prompt with the listing exchange as destination and no EUR data", () => {
    const v = deriveHeldHandoff({ target: VUAA, form: form() });
    expect(v.mode).toBe("held");
    expect(v.destination).toBe("LSEETF");
    expect(v.prompt).toBe(
      "Create buy limit order for 5 shares of VUAA at 112.84 and set destination LSEETF",
    );
    expect(v.documented?.prompt).toBe("Buy 5 shares of VUAA at 112.84 limit");
    expect(v.checklist).toBe(
      "On the ticket confirm: conid 123456 / VUAA / USD / destination LSEETF",
    );
    expect(v.estimate.label).toContain("564.20 USD");
  });

  it("uses SMART when the statement exchange is not an IBKR destination", () => {
    const v = deriveHeldHandoff({ target: { ...VUAA, listingExchange: "XYZQ" }, form: form() });
    expect(v.destination).toBe("SMART");
    expect(v.prompt).toContain("set destination SMART");
  });

  it("gates on quantity and price, and omits the price for a market order", () => {
    expect(deriveHeldHandoff({ target: VUAA, form: form({ quantityText: "" }) }).gate).toBe(
      "needs_quantity",
    );
    expect(deriveHeldHandoff({ target: VUAA, form: form({ priceText: "" }) }).gate).toBe(
      "needs_price",
    );
    const m = deriveHeldHandoff({ target: VUAA, form: form({ orderType: "market" }) });
    expect(m.prompt).toBe(
      "Create buy market order for 5 shares of VUAA and set destination LSEETF",
    );
  });
});

describe("holdingTarget position", () => {
  const position = {
    quantity: 3,
    averageCost: 10,
    currency: "EUR",
    marketValue: { kind: "ok" as const, value: 33, ccy: "EUR" },
    unrealized: { kind: "ok" as const, value: 3, ccy: "EUR" },
    heldSymbol: "MSF",
    heldExchange: "IBIS",
    reportDate: "2026-10-17",
  };
  it("passes a position through to a screened and to a held target", () => {
    const screened = holdingTarget({
      canonicalSecurityId: "s1",
      canonicalSymbol: "MSFT",
      companyName: "Microsoft",
      position,
    });
    expect(screened?.position).toEqual(position);
    const held = holdingTarget({
      canonicalSecurityId: null,
      canonicalSymbol: null,
      companyName: "VANG",
      held: { symbol: "VUAA", listingExchange: null, conid: 1, description: null, currency: "USD" },
      position,
    });
    expect(held?.position).toEqual(position);
  });
  it("leaves the position absent when none is given", () => {
    const t = holdingTarget({
      canonicalSecurityId: "s1",
      canonicalSymbol: "MSFT",
      companyName: "M",
    });
    expect(t?.position).toBeUndefined();
  });
});
