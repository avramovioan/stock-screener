import type { EurListing } from "@core/handoff.ts";
import { describe, expect, it } from "vitest";
import { deriveHandoff, type FormState, INITIAL_FORM } from "./derive";

const msf = (over: Partial<EurListing> = {}): EurListing => ({
  exchange: "IBIS",
  status: "verified",
  conid: 12178239,
  localSymbol: "MSF",
  isin: "US5949181045",
  eurSymbolYahoo: "MSF.DE",
  verifiedAt: "2026-10-15T07:30:00Z",
  verification: {},
  ...over,
});
const form = (over: Partial<FormState> = {}): FormState => ({
  ...INITIAL_FORM,
  quantityText: "10",
  priceText: "400",
  ...over,
});
const derive = (
  listings: EurListing[],
  f: FormState,
  extra: { defaultDestination?: "IBIS2" | "IBIS" | "AEB"; referencePrice?: number | null } = {},
) =>
  deriveHandoff({
    listings,
    form: f,
    defaultDestination: extra.defaultDestination ?? "IBIS2",
    referencePrice: extra.referencePrice ?? null,
  });

describe("deriveHandoff: verified listing", () => {
  it("builds the owner's example prompt", () => {
    const v = derive([msf()], form());
    expect(v.mode).toBe("verified");
    expect(v.gate).toBeNull();
    expect(v.prompt).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(v.documented).toEqual({
      prompt: "Buy 10 shares of MSF at 400 limit",
      ticketNote: "On the ticket set the destination to IBIS2.",
    });
    expect(v.checklist).toBe(
      "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2",
    );
    expect(v.estimate.label).toBe(
      "Estimate before fees: 4,000.00 EUR (10 x 400, limit price); commissions not included",
    );
  });

  it("uses the IBKR local symbol, never the Yahoo ticker", () => {
    const v = derive(
      [msf({ exchange: "AEB", localSymbol: "UNA", eurSymbolYahoo: "UNA.AS" })],
      form({ destination: "AEB" }),
    );
    expect(v.prompt).toBe(
      "Create buy limit order for 10 shares of UNA at 400 and set destination AEB",
    );
    expect(v.prompt).not.toContain(".AS");
  });

  it("omits the price clause for a market order and estimates with the delayed quote", () => {
    const v = derive([msf()], form({ side: "sell", orderType: "market", priceText: "" }), {
      referencePrice: 472.85,
    });
    expect(v.prompt).toBe(
      "Create sell market order for 10 shares of MSF and set destination IBIS2",
    );
    expect(v.errors.price).toBeNull();
    expect(v.estimate.basis).toBe("delayed quote");
  });

  it("waits for a valid quantity and price and explains a decimal comma instead of guessing", () => {
    expect(derive([msf()], form({ quantityText: "" })).gate).toBe("needs_quantity");
    expect(derive([msf()], form({ quantityText: "0" })).errors.quantity).toContain(
      "positive whole number",
    );
    const comma = derive([msf()], form({ priceText: "472,85" }));
    expect(comma.gate).toBe("needs_price");
    expect(comma.prompt).toBeNull();
    expect(comma.errors.price).toContain("dot");
    expect(derive([msf()], form({ priceText: "" })).errors.price).toBeNull();
  });
});

describe("deriveHandoff: destination (spec 13.3)", () => {
  it("keeps the profile default when the listing is on IBIS", () => {
    const v = derive([msf()], form(), { defaultDestination: "IBIS2" });
    expect([v.destination, v.destinationNote, v.destinationOptions]).toEqual([
      "IBIS2",
      null,
      ["IBIS2", "IBIS"],
    ]);
  });

  it("pre-selects AEB with a reason when only an AEB listing exists", () => {
    const v = derive([msf({ exchange: "AEB", localSymbol: "ASML" })], form(), {
      defaultDestination: "IBIS2",
    });
    expect(v.destination).toBe("AEB");
    expect(v.destinationNote).toContain("IBIS2");
    expect(v.destinationOptions).toEqual(["AEB"]);
  });

  it("keeps an explicit choice and shows no note", () => {
    const v = derive([msf()], form({ destination: "IBIS" }), { defaultDestination: "AEB" });
    expect([v.destination, v.destinationNote]).toEqual(["IBIS", null]);
  });

  it("prefers a verified AEB line over an unverified IBIS line and derives the destinations from the shown line", () => {
    const v = derive(
      [
        msf({ status: "unverified", verifiedAt: null }),
        msf({ exchange: "AEB", localSymbol: "MSFA" }),
      ],
      form({ acknowledged: false }),
    );
    expect(v.mode).toBe("verified");
    expect(v.listing?.exchange).toBe("AEB");
    expect(v.destinationOptions).toEqual(["AEB"]);
  });
});

describe("deriveHandoff: unverified listing", () => {
  const unverified = msf({ status: "unverified", verifiedAt: null, eurSymbolYahoo: null });

  it("shows no prompt until the acknowledgement is ticked", () => {
    const before = derive([unverified], form());
    expect(before.mode).toBe("unverified");
    expect(before.gate).toBe("needs_acknowledgement");
    expect(before.prompt).toBeNull();
    expect(before.checklist).toBeNull();
    const after = derive([unverified], form({ acknowledged: true }));
    expect(after.gate).toBeNull();
    expect(after.prompt).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
  });

  it("refuses an unusable catalogue symbol even after the acknowledgement", () => {
    const v = derive(
      [msf({ status: "unverified", localSymbol: "MSFd", verifiedAt: null })],
      form({ acknowledged: true }),
    );
    expect(v.gate).toBe("invalid_symbol");
    expect(v.errors.symbol).toContain("upper-case");
  });
});

describe("deriveHandoff: no EUR equivalent", () => {
  const none = msf({
    status: "none",
    conid: null,
    localSymbol: null,
    eurSymbolYahoo: null,
    isin: null,
    verifiedAt: null,
  });

  it("asks for a symbol, then builds a prompt from it with an unknown conid", () => {
    const empty = derive([none], form());
    expect([empty.mode, empty.listing, empty.gate, empty.prompt]).toEqual([
      "none",
      null,
      "needs_symbol",
      null,
    ]);
    const typed = derive([none], form({ manualSymbol: " msf " }));
    expect(typed.gate).toBeNull();
    expect(typed.localSymbol).toBe("MSF");
    expect(typed.prompt).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(typed.checklist).toContain("conid unknown");
    expect(typed.destinationOptions).toEqual(["IBIS2", "IBIS", "AEB"]);
  });

  it("works the same with no stored rows at all, and rejects a malformed symbol", () => {
    expect(derive([], form({ manualSymbol: "MSF" })).prompt).not.toBeNull();
    const bad = derive([], form({ manualSymbol: "MSF; cancel all" }));
    expect(bad.gate).toBe("invalid_symbol");
    expect(bad.prompt).toBeNull();
    const yahoo = derive([], form({ manualSymbol: "msf.de" }));
    expect(yahoo.gate).toBe("invalid_symbol");
    expect(yahoo.errors.symbol).toBe(
      "That looks like a Yahoo ticker (MSF.DE). Use the IBKR local symbol (MSF).",
    );
    expect(yahoo.prompt).toBeNull();
  });
});
