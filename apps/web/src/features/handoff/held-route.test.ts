import { describe, expect, it } from "vitest";
import { createHandoffApi, parseCatalogueRow } from "./handoff-api";
import { type CatalogueRow, chooseHeldRoute } from "./held-destination";

const IBIS: CatalogueRow = {
  exchange: "IBIS",
  conid: 111,
  localSymbol: "VUSD",
  currency: "EUR",
};
const AEB: CatalogueRow = { exchange: "AEB", conid: 222, localSymbol: "VUSA", currency: "EUR" };
const held = { symbol: "VUSA", listingExchange: "AEB" };

describe("chooseHeldRoute", () => {
  it("prefers Xetra and honours an IBIS2 default", () => {
    const r = chooseHeldRoute({ rows: [AEB, IBIS], preferred: "IBIS2", held });
    expect(r).toMatchObject({
      destination: "IBIS2",
      localSymbol: "VUSD",
      conid: 111,
      note: "xetra",
      fallback: false,
    });
  });
  it("uses IBIS when the default is IBIS or AEB", () => {
    expect(chooseHeldRoute({ rows: [AEB, IBIS], preferred: "IBIS", held }).destination).toBe(
      "IBIS",
    );
    expect(chooseHeldRoute({ rows: [AEB, IBIS], preferred: "AEB", held }).destination).toBe("IBIS");
  });
  it("uses AEB when only Amsterdam lists it", () => {
    expect(chooseHeldRoute({ rows: [AEB], preferred: "IBIS2", held })).toMatchObject({
      destination: "AEB",
      localSymbol: "VUSA",
      note: "amsterdam",
    });
  });
  it("falls back to the statement exchange without rows", () => {
    expect(chooseHeldRoute({ rows: [], preferred: "IBIS2", held })).toMatchObject({
      destination: "AEB",
      localSymbol: "VUSA",
      conid: null,
      note: "statement",
    });
    expect(
      chooseHeldRoute({
        rows: null,
        preferred: "IBIS2",
        held: { symbol: "X", listingExchange: "ZZ" },
      }),
    ).toMatchObject({ destination: "SMART", fallback: true, note: "statement" });
  });
});

describe("catalogue lookup", () => {
  it("parses rows and drops unknown exchanges", () => {
    expect(
      parseCatalogueRow({
        exchange_id: "IBIS",
        conid: 5,
        local_symbol: "VUSD",
        currency: "EUR",
      }),
    ).toEqual({ exchange: "IBIS", conid: 5, localSymbol: "VUSD", currency: "EUR" });
    expect(parseCatalogueRow({ exchange_id: "LSE", conid: 5 })).toBeNull();
  });
  it("reads by ISIN and throws on error", async () => {
    const chain = (result: unknown) => ({
      select: () => ({ eq: () => Promise.resolve(result) }),
    });
    const ok = createHandoffApi({
      from: () =>
        chain({
          data: [{ exchange_id: "AEB", conid: 2, local_symbol: "VUSA", currency: "EUR" }],
          error: null,
        }),
    } as never);
    expect(await ok.getCatalogueListings("IE00B3XXRP09")).toHaveLength(1);
    const bad = createHandoffApi({
      from: () => chain({ data: null, error: { message: "x" } }),
    } as never);
    await expect(bad.getCatalogueListings("IE00B3XXRP09")).rejects.toThrow();
  });
});
