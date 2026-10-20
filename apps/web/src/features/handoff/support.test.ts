import { describe, expect, it, vi } from "vitest";
import { type CopyEnv, copyText } from "./copy-text";
import { createHandoffApi, parseEurListing } from "./handoff-api";
import { holdingTarget } from "./holding-target";
import { formatUtcStamp, prefillPrice, usableEurQuote } from "./quote-text";

const quote = (over: Record<string, unknown> = {}) => ({
  symbol: "MSF.DE",
  currency: "EUR",
  exchange: "GER",
  fullExchangeName: "XETRA",
  longName: "Microsoft Corporation",
  regularMarketPrice: 472.853,
  regularMarketTime: Date.UTC(2026, 9, 15, 8, 27, 12),
  regularMarketChangePercent: null,
  marketState: "CLOSED",
  fetchedAt: "2026-10-15T08:30:00Z",
  stale: false,
  ...over,
});

describe("quote text", () => {
  it("formats times in UTC whatever the browser time zone", () => {
    expect(formatUtcStamp(Date.UTC(2026, 9, 15, 8, 27))).toBe("15 Oct 2026, 08:27 UTC");
    expect(formatUtcStamp(Date.UTC(2027, 0, 5, 23, 5))).toBe("5 Jan 2027, 23:05 UTC");
  });

  it("accepts a EUR quote and rejects every other currency, missing prices and missing times", () => {
    expect(usableEurQuote(quote())).toEqual({
      price: 472.853,
      stamp: "15 Oct 2026, 08:27 UTC",
      stale: false,
    });
    expect(usableEurQuote(quote({ currency: "USD" }))).toBeNull();
    expect(usableEurQuote(quote({ regularMarketPrice: null }))).toBeNull();
    expect(usableEurQuote(quote({ regularMarketPrice: 0 }))).toBeNull();
    expect(usableEurQuote(quote({ regularMarketTime: null }))).toBeNull();
    expect(usableEurQuote(undefined)).toBeNull();
  });

  it("rounds the prefill to 2 decimals", () => {
    expect(prefillPrice(472.853)).toBe("472.85");
    expect(prefillPrice(400)).toBe("400.00");
  });
});

describe("copyText", () => {
  const box = () => {
    const el = document.createElement("textarea");
    el.value = "prompt";
    document.body.append(el);
    return el;
  };

  it("uses the clipboard API when it works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const env: CopyEnv = { clipboard: { writeText }, execCopy: vi.fn().mockReturnValue(false) };
    expect(await copyText("prompt", box(), env)).toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith("prompt");
    expect(env.execCopy).not.toHaveBeenCalled();
  });

  it("falls back to select-and-copy when the clipboard API rejects or is missing", async () => {
    const el = box();
    const select = vi.spyOn(el, "select");
    const rejecting: CopyEnv = {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      execCopy: vi.fn().mockReturnValue(true),
    };
    expect(await copyText("prompt", el, rejecting)).toBe("fallback");
    expect(select).toHaveBeenCalled();
    expect(await copyText("prompt", el, { clipboard: undefined, execCopy: () => true })).toBe(
      "fallback",
    );
  });

  it("reports failure (text stays selected) when nothing works", async () => {
    expect(await copyText("prompt", box(), { clipboard: undefined, execCopy: () => false })).toBe(
      "failed",
    );
    expect(await copyText("prompt", null, { clipboard: undefined, execCopy: () => true })).toBe(
      "failed",
    );
  });
});

describe("handoff api", () => {
  const verified = {
    ibkr_exchange_id: "IBIS",
    status: "verified",
    ibkr_conid: 12178239,
    ibkr_local_symbol: "MSF",
    isin: "US5949181045",
    eur_symbol_yahoo: "MSF.DE",
    verification: { failed: [] },
    verified_at: "2026-10-15T07:30:00Z",
  };

  it("maps a row and drops rows it does not understand", () => {
    expect(parseEurListing(verified)).toEqual({
      exchange: "IBIS",
      status: "verified",
      conid: 12178239,
      localSymbol: "MSF",
      isin: "US5949181045",
      eurSymbolYahoo: "MSF.DE",
      verifiedAt: "2026-10-15T07:30:00Z",
      verification: { failed: [] },
    });
    expect(parseEurListing({ ...verified, ibkr_exchange_id: "FWB" })).toBeNull();
    expect(parseEurListing({ ...verified, status: "maybe" })).toBeNull();
    expect(parseEurListing(null)).toBeNull();
    expect(
      parseEurListing({ ...verified, ibkr_conid: "12178239", verification: null })?.conid,
    ).toBeNull();
  });

  function client(result: { data: unknown; error: { message: string } | null }) {
    const calls: { table: string; select?: string; eq?: [string, unknown]; update?: unknown }[] =
      [];
    const builder = (table: string) => {
      const call: (typeof calls)[number] = { table };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (s: string) => {
          call.select = s;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          call.eq = [c, v];
          return Object.assign(Promise.resolve(result), chain);
        },
        update: (u: unknown) => {
          call.update = u;
          return chain;
        },
        maybeSingle: () => Promise.resolve(result),
      };
      return chain;
    };
    return { calls, from: builder } as never as { from: (t: string) => never } & {
      calls: typeof calls;
    };
  }

  it("reads the EUR lines of one security and the own default destination", async () => {
    const c = client({ data: [verified, { ibkr_exchange_id: "XX" }], error: null });
    const api = createHandoffApi(c as never);
    expect((await api.getEurListings("sec-1")).map((l) => l.localSymbol)).toEqual(["MSF"]);
    expect(c.calls[0]).toMatchObject({ table: "eur_equivalents", eq: ["security_id", "sec-1"] });

    const d = createHandoffApi(
      client({ data: { default_destination: "AEB" }, error: null }) as never,
    );
    expect(await d.getDefaultDestination("u1")).toBe("AEB");
    const bad = createHandoffApi(
      client({ data: { default_destination: "SMART" }, error: null }) as never,
    );
    expect(await bad.getDefaultDestination("u1")).toBe("IBIS2");
  });

  it("writes only a valid destination to the own row and surfaces errors in plain words", async () => {
    const c = client({ data: null, error: null });
    const api = createHandoffApi(c as never);
    await api.setDefaultDestination("u1", "IBIS");
    expect(c.calls[0]).toMatchObject({
      table: "profiles",
      update: { default_destination: "IBIS" },
      eq: ["user_id", "u1"],
    });
    await expect(api.setDefaultDestination("u1", "SMART" as never)).rejects.toThrow(
      "Choose IBIS2, IBIS or AEB.",
    );
    const failing = createHandoffApi(client({ data: null, error: { message: "boom" } }) as never);
    await expect(failing.setDefaultDestination("u1", "AEB")).rejects.toThrow(
      "Could not save your default destination.",
    );
    await expect(failing.getEurListings("s")).rejects.toThrow("Could not load the EUR listing.");
  });
});

describe("holdingTarget", () => {
  it("targets the canonical screening security of the company, with no rank", () => {
    expect(
      holdingTarget({
        canonicalSecurityId: "sec-msft",
        canonicalSymbol: "MSFT",
        companyName: "Microsoft Corporation",
        exchangeName: "NasdaqGS",
        currency: "USD",
      }),
    ).toEqual({
      securityId: "sec-msft",
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      rank: null,
      exchangeName: "NasdaqGS",
      currency: "USD",
    });
    expect(
      holdingTarget({ canonicalSecurityId: "s", canonicalSymbol: "X", companyName: "X Inc." }),
    ).toMatchObject({ exchangeName: null, currency: null });
  });

  it("offers no target for an unmatched position", () => {
    expect(
      holdingTarget({ canonicalSecurityId: null, canonicalSymbol: null, companyName: "Unknown" }),
    ).toBeNull();
    expect(
      holdingTarget({ canonicalSecurityId: "s", canonicalSymbol: null, companyName: "Unknown" }),
    ).toBeNull();
  });
});
