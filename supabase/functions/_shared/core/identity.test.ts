import { describe, expect, it } from "vitest";
import {
  applyForceCanonical,
  chooseCanonical,
  groupListings,
  type ListingFact,
  normalizeName,
  type Override,
} from "./identity.ts";

let seq = 0;
function listing(
  symbol: string,
  exchange: string,
  country: string,
  patch: Partial<ListingFact> = {},
): ListingFact {
  seq++;
  return {
    securityId: `id-${String(seq).padStart(3, "0")}-${symbol}`,
    symbol,
    exchange,
    venueClass: "primary",
    exchangeCountry: country,
    longName: null,
    marketCapUsd: null,
    sharesOutstanding: null,
    avgUsdVolume30d: null,
    firstTradeDay: null,
    ...patch,
  };
}
const symbolsOf = (groups: ListingFact[][]) => groups.map((g) => g.map((l) => l.symbol));

describe("normalizeName", () => {
  it.each([
    ["Microsoft Corporation", "microsoft"],
    ["MICROSOFT CORP.", "microsoft"],
    ["Alphabet Inc.", "alphabet"],
    ["Nestlé S.A.", "nestle"],
    ["SAP SE", "sap"],
    ["AT&T Inc.", "at and t"],
    ["Taiwan Semiconductor Manufacturing Company Limited", "taiwan semiconductor manufacturing"],
    ["Royal Dutch Shell plc", "royal dutch shell"],
    ["Berkshire Hathaway Inc.", "berkshire hathaway"],
    ["Samsung Electronics Co., Ltd.", "samsung electronics"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
  it("keeps group and holding words so distinct companies never merge", () => {
    expect(normalizeName("Prosus Group N.V.")).toBe("prosus group");
    expect(normalizeName("Alibaba Group Holding Limited")).toBe("alibaba group holding");
  });
  it("never reduces a name to nothing and handles empty input", () => {
    expect(normalizeName("Inc")).toBe("inc");
    expect(normalizeName("")).toBe("");
  });
});

describe("groupListings", () => {
  it("groups MSFT with its German cross-listing MSF.DE by name and market cap, and keeps AAPL apart", () => {
    const msft = listing("MSFT", "NMS", "United States", {
      longName: "Microsoft Corporation",
      marketCapUsd: 3.96e12,
      sharesOutstanding: 7_425_545_491,
    });
    const msfde = listing("MSF.DE", "GER", "Germany", {
      longName: "Microsoft Corporation",
      marketCapUsd: 3.94e12,
      sharesOutstanding: 7_425_545_491,
    });
    const aapl = listing("AAPL", "NMS", "United States", {
      longName: "Apple Inc.",
      marketCapUsd: 3.4e12,
    });
    const { groups, needsReview } = groupListings([aapl, msfde, msft], []);
    expect(symbolsOf(groups)).toEqual([["AAPL"], ["MSF.DE", "MSFT"]]);
    expect(needsReview).toEqual([]);
  });

  it("groups TSMC's ordinary line with the ADR despite the company-suffix difference", () => {
    const tw = listing("2330.TW", "TAI", "Taiwan", {
      longName: "Taiwan Semiconductor Manufacturing Company Limited",
      marketCapUsd: 1.0e12,
    });
    const adr = listing("TSM", "NYQ", "United States", {
      longName: "Taiwan Semiconductor Manufacturing Co Ltd",
      marketCapUsd: 1.02e12,
    });
    expect(symbolsOf(groupListings([adr, tw], []).groups)).toEqual([["2330.TW", "TSM"]]);
  });

  it("a same-name pair whose caps differ by more than 40% is two companies (look-alike exclusion by cap mismatch)", () => {
    const a = listing("NES", "NYQ", "United States", { longName: "Nestle", marketCapUsd: 100e9 });
    const b = listing("NESTLEIND.NS", "NSI", "India", { longName: "Nestle", marketCapUsd: 20e9 });
    const r = groupListings([a, b], []);
    expect(symbolsOf(r.groups)).toEqual([["NES"], ["NESTLEIND.NS"]]);
    expect(r.needsReview).toEqual([]);
  });

  it("a same-name pair 15-40% apart goes to review and is not grouped", () => {
    const a = listing("AAA", "NYQ", "United States", {
      longName: "Acme Corp",
      marketCapUsd: 100e9,
    });
    const b = listing("AAA.L", "LSE", "United Kingdom", {
      longName: "Acme Corporation",
      marketCapUsd: 75e9,
    });
    const r = groupListings([a, b], []);
    expect(symbolsOf(r.groups)).toEqual([["AAA"], ["AAA.L"]]);
    expect(r.needsReview).toHaveLength(1);
    expect(r.needsReview[0]?.why).toBe("cap_mismatch");
  });

  it("equal share counts alone (different names, similar caps) go to review, not into one group", () => {
    const a = listing("ONE", "NYQ", "United States", {
      longName: "Alpha Industries",
      marketCapUsd: 100e9,
      sharesOutstanding: 1_000_000_000,
    });
    const b = listing("TWO", "NYQ", "United States", {
      longName: "Beta Holdings",
      marketCapUsd: 98e9,
      sharesOutstanding: 1_000_000_000,
    });
    const r = groupListings([a, b], []);
    expect(symbolsOf(r.groups)).toEqual([["ONE"], ["TWO"]]);
    expect(r.needsReview.map((p) => p.why)).toEqual(["shares_only"]);
  });

  it("ASM.F (different company, different shares) never joins ASML even with a similar prefix", () => {
    const asml = listing("ASML", "NMS", "Netherlands", {
      longName: "ASML Holding N.V.",
      marketCapUsd: 380e9,
      sharesOutstanding: 384_100_000,
    });
    const asm = listing("ASM.F", "FRA", "Germany", {
      longName: "ASM International NV",
      marketCapUsd: 30e9,
      sharesOutstanding: 17_500_431_702,
    });
    expect(symbolsOf(groupListings([asml, asm], []).groups)).toEqual([["ASM.F"], ["ASML"]]);
  });

  it("name match with an unknown cap still groups (secondary lines without data)", () => {
    const a = listing("MSFT", "NMS", "United States", {
      longName: "Microsoft Corporation",
      marketCapUsd: 3.9e12,
    });
    const b = listing("MSF.MU", "MUN", "Germany", {
      longName: "Microsoft Corp",
      venueClass: "secondary_only",
    });
    expect(symbolsOf(groupListings([a, b], []).groups)).toEqual([["MSF.MU", "MSFT"]]);
  });

  it("override exclude removes a listing, merge_into_company unions two listings", () => {
    const a = listing("AAA", "NYQ", "United States", {
      longName: "Acme Corp",
      marketCapUsd: 100e9,
    });
    const b = listing("BBB", "NYQ", "United States", {
      longName: "Totally Different",
      marketCapUsd: 10e9,
    });
    const c = listing("CCC", "NYQ", "United States", {
      longName: "Another One",
      marketCapUsd: 11e9,
    });
    const overrides: Override[] = [
      { kind: "exclude", yahooSymbol: "CCC" },
      { kind: "merge_into_company", yahooSymbol: "BBB", targetYahooSymbol: "AAA" },
    ];
    expect(symbolsOf(groupListings([a, b, c], overrides).groups)).toEqual([["AAA", "BBB"]]);
  });

  it("is deterministic regardless of input order", () => {
    const xs = [
      listing("MSFT", "NMS", "United States", {
        longName: "Microsoft Corporation",
        marketCapUsd: 3.9e12,
      }),
      listing("MSF.DE", "GER", "Germany", {
        longName: "Microsoft Corporation",
        marketCapUsd: 3.9e12,
      }),
      listing("AAPL", "NMS", "United States", { longName: "Apple Inc.", marketCapUsd: 3.4e12 }),
    ];
    expect(symbolsOf(groupListings(xs, []).groups)).toEqual(
      symbolsOf(groupListings([...xs].reverse(), []).groups),
    );
  });
});

describe("chooseCanonical", () => {
  const opts = { switchRatio: 1.5 };

  it("Alphabet classes: the higher 30-day volume class is canonical, the other is a share_class", () => {
    const goog = listing("GOOG", "NMS", "United States", { avgUsdVolume30d: 3.0e9 });
    const googl = listing("GOOGL", "NMS", "United States", { avgUsdVolume30d: 4.1e9 });
    const r = chooseCanonical([goog, googl], "United States", null, opts);
    expect(r.canonicalId).toBe(googl.securityId);
    expect(r.roles[goog.securityId]).toBe("share_class");
    expect(r.roles[googl.securityId]).toBe("canonical");
    expect(r.flags).toEqual([]);
  });

  it("Berkshire: BRK-B (liquid) beats BRK-A", () => {
    const a = listing("BRK-A", "NYQ", "United States", { avgUsdVolume30d: 8e7 });
    const b = listing("BRK-B", "NYQ", "United States", { avgUsdVolume30d: 2.5e9 });
    expect(chooseCanonical([a, b], "United States", null, opts).canonicalId).toBe(b.securityId);
  });

  it("equal volume breaks ties by ascending symbol", () => {
    const x = listing("BBB", "NYQ", "United States", { avgUsdVolume30d: 1e9 });
    const y = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: 1e9 });
    expect(chooseCanonical([x, y], "United States", null, opts).canonicalId).toBe(y.securityId);
  });

  it("TSMC: the Taiwan home line is canonical although the ADR trades more; the ADR is never canonical", () => {
    const tw = listing("2330.TW", "TAI", "Taiwan", { avgUsdVolume30d: 1.0e9 });
    const adr = listing("TSM", "NYQ", "United States", { avgUsdVolume30d: 2.0e9 });
    const r = chooseCanonical([adr, tw], "Taiwan", null, opts);
    expect(r.canonicalId).toBe(tw.securityId);
    expect(r.roles[adr.securityId]).toBe("adr");
  });

  it("Shell: SHEL.L (home UK) is canonical and the NYSE line is an adr", () => {
    const l = listing("SHEL.L", "LSE", "United Kingdom", { avgUsdVolume30d: 4e8 });
    const ny = listing("SHEL", "NYQ", "United States", { avgUsdVolume30d: 6e8 });
    const r = chooseCanonical([l, ny], "United Kingdom", null, opts);
    expect(r.canonicalId).toBe(l.securityId);
    expect(r.roles[ny.securityId]).toBe("adr");
  });

  it("MSFT vs German lines: Xetra cross-line is a foreign_listing, the Frankfurt line a secondary_venue, OTC is excluded", () => {
    const msft = listing("MSFT", "NMS", "United States", { avgUsdVolume30d: 1.4e10 });
    const msfde = listing("MSF.DE", "GER", "Germany", { avgUsdVolume30d: 3e7 });
    const msff = listing("MSF.F", "FRA", "Germany", {
      venueClass: "secondary_only",
      avgUsdVolume30d: 1e6,
    });
    const otc = listing("MSFTF", "PNK", "United States", { venueClass: "otc" });
    const r = chooseCanonical([msft, msfde, msff, otc], "United States", null, opts);
    expect(r.canonicalId).toBe(msft.securityId);
    expect(r.roles[msfde.securityId]).toBe("foreign_listing");
    expect(r.roles[msff.securityId]).toBe("secondary_venue");
    expect(r.roles[otc.securityId]).toBe("excluded");
  });

  it("without a known home country and two primary listings the company is excluded (country_unknown)", () => {
    const us = listing("ABC", "NYQ", "United States", { avgUsdVolume30d: 5e8 });
    const de = listing("ABC.DE", "GER", "Germany", { avgUsdVolume30d: 1e8 });
    const r = chooseCanonical([us, de], null, null, opts);
    expect(r.canonicalId).toBeNull();
    expect(r.exclusion).toBe("country_unknown");
  });

  it("a company whose listings are all on secondary venues has no primary listing", () => {
    const f = listing("XYZ.F", "FRA", "Germany", { venueClass: "secondary_only" });
    const r = chooseCanonical([f], "Germany", null, opts);
    expect(r.canonicalId).toBeNull();
    expect(r.flags).toEqual(["no_primary_listing"]);
    expect(r.roles[f.securityId]).toBe("secondary_venue");
  });

  it("missing volume ranks last; all missing keeps the current canonical and flags canonical_unverified", () => {
    const a = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: null });
    const b = listing("BBB", "NYQ", "United States", { avgUsdVolume30d: 1e6 });
    expect(chooseCanonical([a, b], "United States", null, opts).canonicalId).toBe(b.securityId);

    const c = listing("CCC", "NYQ", "United States");
    const d = listing("DDD", "NYQ", "United States");
    const kept = chooseCanonical([c, d], "United States", { securityId: d.securityId }, opts);
    expect(kept.canonicalId).toBe(d.securityId);
    expect(kept.flags).toEqual(["canonical_unverified"]);
    const fresh = chooseCanonical([c, d], "United States", null, opts);
    expect(fresh.canonicalId).toBe(c.securityId);
    expect(fresh.flags).toEqual(["canonical_unverified"]);
  });

  describe("hysteresis (1.5x)", () => {
    const old = listing("OLD", "NYQ", "United States", { avgUsdVolume30d: 1.0e9 });
    const mk = (volume: number) =>
      listing("NEW", "NYQ", "United States", { avgUsdVolume30d: volume });

    it("keeps the current canonical when the challenger has only 1.2x the volume", () => {
      const challenger = mk(1.2e9);
      const r = chooseCanonical(
        [old, challenger],
        "United States",
        { securityId: old.securityId },
        opts,
      );
      expect(r.canonicalId).toBe(old.securityId);
      expect(r.flags).toEqual(["canonical_switch_blocked"]);
      expect(r.roles[challenger.securityId]).toBe("share_class");
    });
    it("switches at exactly 1.5x", () => {
      const challenger = mk(1.5e9);
      const r = chooseCanonical(
        [old, challenger],
        "United States",
        { securityId: old.securityId },
        opts,
      );
      expect(r.canonicalId).toBe(challenger.securityId);
      expect(r.flags).toEqual(["canonical_switched"]);
    });
    it("blocks a switch to a challenger that fails the history tests (a new share class never resets the history)", () => {
      const challenger = mk(5e9);
      const r = chooseCanonical(
        [old, challenger],
        "United States",
        { securityId: old.securityId },
        {
          switchRatio: 1.5,
          isHistoryEligible: (l) => l.securityId !== challenger.securityId,
        },
      );
      expect(r.canonicalId).toBe(old.securityId);
      expect(r.flags).toEqual(["canonical_switch_blocked"]);
    });
    it("a current canonical that is no longer a candidate is replaced without hysteresis", () => {
      const challenger = mk(1e8);
      const r = chooseCanonical([challenger], "United States", { securityId: "gone" }, opts);
      expect(r.canonicalId).toBe(challenger.securityId);
    });
  });
});

describe("applyForceCanonical", () => {
  it("a force_canonical override beats volume and hysteresis", () => {
    const a = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: 9e9 });
    const b = listing("BBB", "NYQ", "United States", { avgUsdVolume30d: 1e9 });
    const base = chooseCanonical([a, b], "United States", null, { switchRatio: 1.5 });
    expect(base.canonicalId).toBe(a.securityId);
    const forced = applyForceCanonical([a, b], base, [
      { kind: "force_canonical", yahooSymbol: "BBB" },
    ]);
    expect(forced.canonicalId).toBe(b.securityId);
    expect(forced.roles[a.securityId]).toBe("share_class");
    expect(forced.roles[b.securityId]).toBe("canonical");
    expect(forced.flags).toContain("canonical_forced");
  });
  it("is a no-op without a matching override", () => {
    const a = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: 9e9 });
    const base = chooseCanonical([a], "United States", null, { switchRatio: 1.5 });
    expect(applyForceCanonical([a], base, [{ kind: "force_canonical", yahooSymbol: "ZZZ" }])).toBe(
      base,
    );
  });
});

describe("primary listing rule (A-50)", () => {
  const opts = { switchRatio: 1.5 };
  const US = "United States";
  const idex = (patch: Partial<ListingFact> = {}) =>
    listing("0J8P.L", "LSE", "United Kingdom", {
      longName: "IDEXX Laboratories, Inc.",
      avgUsdVolume30d: 9e9,
      ...patch,
    });

  it.each([
    ["IDEXX", "0J8P.L", "United States"],
    ["Archer-Daniels-Midland", "0JQQ.L", "United States"],
    ["NetApp", "0K6F.L", "United States"],
    ["Schindler", "0QOT.L", "Switzerland"],
  ])(
    "%s: an IOB line is never canonical, the home listing wins whatever the volume",
    (_n, iob, country) => {
      const line = listing(iob, "LSE", "United Kingdom", { avgUsdVolume30d: 9e9 });
      const home =
        country === "Switzerland"
          ? listing("SCHN.SW", "EBS", country, { avgUsdVolume30d: 1e6 })
          : listing("HOME", "NYQ", country, { avgUsdVolume30d: 1e6 });
      const r = chooseCanonical([line, home], country, null, opts);
      expect(r.canonicalId).toBe(home.securityId);
      expect(r.exclusion).toBeNull();
      expect(r.roles[line.securityId]).toBe("secondary_venue");
    },
  );

  it.each([
    ["IDEXX", "0J8P.L", US],
    ["Archer-Daniels-Midland", "0JQQ.L", US],
    ["NetApp", "0K6F.L", US],
    ["Schindler", "0QOT.L", "Switzerland"],
  ])(
    "%s: a company whose only listing is an IOB line is excluded (no_primary_listing)",
    (_n, iob, country) => {
      const line = listing(iob, "LSE", "United Kingdom", { avgUsdVolume30d: 9e9 });
      const r = chooseCanonical([line], country, null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("no_primary_listing");
      expect(r.flags).toContain("no_primary_listing");
      expect(r.roles[line.securityId]).toBe("secondary_venue");
    },
  );

  it("a UK company whose only line is an IOB line is excluded too", () => {
    const r = chooseCanonical([idex()], "United Kingdom", null, opts);
    expect(r.canonicalId).toBeNull();
    expect(r.exclusion).toBe("no_primary_listing");
  });

  it("a UK company keeps its ordinary LSE line over a busier IOB line", () => {
    const iob = idex({ avgUsdVolume30d: 9e9 });
    const lse = listing("ABC.L", "LSE", "United Kingdom", { avgUsdVolume30d: 1e6 });
    expect(chooseCanonical([iob, lse], "United Kingdom", null, opts).canonicalId).toBe(
      lse.securityId,
    );
  });

  it("a foreign primary listing is never canonical when the home exchange is not in the universe", () => {
    const adr = listing("SAP", "NYQ", US, {
      currency: "USD",
      financialCurrency: "EUR",
      avgUsdVolume30d: 9e9,
    });
    const r = chooseCanonical([adr], "Germany", null, opts);
    expect(r.canonicalId).toBeNull();
    expect(r.exclusion).toBe("no_primary_listing");
    expect(r.roles[adr.securityId]).toBe("excluded");
  });

  it("a canonical that violates the rule is replaced at once (no 1.5x volume ratio, no history test)", () => {
    const iob = idex();
    const home = listing("IDXX", "NMS", US, { avgUsdVolume30d: 1e6 });
    const r = chooseCanonical(
      [iob, home],
      US,
      { securityId: iob.securityId },
      { switchRatio: 1.5, isHistoryEligible: () => false },
    );
    expect(r.canonicalId).toBe(home.securityId);
    expect(r.flags).not.toContain("canonical_switch_blocked");
  });

  describe("unknown country", () => {
    it("Ericsson: country null and only an IOB line is excluded (country_unknown)", () => {
      const line = listing("0O86.L", "LSE", "United Kingdom", {
        longName: "Telefonaktiebolaget LM Ericsson",
      });
      const r = chooseCanonical([line], null, null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("country_unknown");
    });
    it("exactly one non-IOB listing: the home country is that exchange country", () => {
      const line = listing("0QOT.L", "LSE", "United Kingdom");
      const sw = listing("SCHN.SW", "EBS", "Switzerland", { avgUsdVolume30d: 1e6 });
      const r = chooseCanonical([line, sw], null, null, opts);
      expect(r.canonicalId).toBe(sw.securityId);
      expect(r.exclusion).toBeNull();
      expect(r.inferredCountry).toBe("Switzerland");
    });
    it("two non-IOB listings: excluded (country_unknown)", () => {
      const a = listing("ABC.SW", "EBS", "Switzerland", { avgUsdVolume30d: 1e6 });
      const b = listing("ABC", "NYQ", US, { avgUsdVolume30d: 5e6 });
      const r = chooseCanonical([a, b], null, null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("country_unknown");
    });
    it("a secondary-venue line does not count as a second listing", () => {
      const a = listing("ABC.SW", "EBS", "Switzerland", { avgUsdVolume30d: 1e6 });
      const f = listing("ABC.F", "FRA", "Germany", { venueClass: "secondary_only" });
      expect(chooseCanonical([a, f], null, null, opts).canonicalId).toBe(a.securityId);
    });
  });

  describe("exchange priority among home listings", () => {
    it("NSE over BSE even when BSE trades more and NSE has no volume", () => {
      const bse = listing("RELIANCE.BO", "BSE", "India", { avgUsdVolume30d: 9e9 });
      const nse = listing("RELIANCE.NS", "NSI", "India", { avgUsdVolume30d: null });
      const r = chooseCanonical([bse, nse], "India", null, opts);
      expect(r.canonicalId).toBe(nse.securityId);
      expect(r.roles[bse.securityId]).toBe("share_class");
    });
    it("BSE alone is a home listing and stays canonical", () => {
      const bse = listing("RELIANCE.BO", "BSE", "India", { avgUsdVolume30d: 9e9 });
      expect(chooseCanonical([bse], "India", null, opts).canonicalId).toBe(bse.securityId);
    });
    it("moves a BSE canonical to NSE without the volume ratio", () => {
      const bse = listing("RELIANCE.BO", "BSE", "India", { avgUsdVolume30d: 9e9 });
      const nse = listing("RELIANCE.NS", "NSI", "India", { avgUsdVolume30d: 1e9 });
      const r = chooseCanonical([bse, nse], "India", { securityId: bse.securityId }, opts);
      expect(r.canonicalId).toBe(nse.securityId);
    });
    it("same-priority share classes still compete on volume", () => {
      const a = listing("BRK-A", "NYQ", US, { avgUsdVolume30d: 1e7 });
      const b = listing("BRK-B", "NYQ", US, { avgUsdVolume30d: 3e9 });
      expect(chooseCanonical([a, b], US, null, opts).canonicalId).toBe(b.securityId);
    });
    it("an exact country match beats an aliased one (China: Shanghai over Hong Kong)", () => {
      const hk = listing("0857.HK", "HKG", "Hong Kong", { avgUsdVolume30d: 9e9 });
      const sh = listing("601857.SS", "SHH", "China", { avgUsdVolume30d: 1e8 });
      expect(chooseCanonical([hk, sh], "China", null, opts).canonicalId).toBe(sh.securityId);
    });
    it("a company headquartered in China and listed only in Hong Kong has a home listing", () => {
      const hk = listing("0700.HK", "HKG", "Hong Kong", { avgUsdVolume30d: 9e9 });
      expect(chooseCanonical([hk], "China", null, opts).canonicalId).toBe(hk.securityId);
    });
  });

  describe("shares only", () => {
    const bondName = "Crédit Agricole S.A. 1.3% SNR BDS 08/02/2027 EUR1";
    it("a bond-like line is excluded and never canonical, the share is", () => {
      const share = listing("ACA.PA", "PAR", "France", {
        longName: "Crédit Agricole S.A.",
        avgUsdVolume30d: 1e6,
      });
      const bond = listing("ACALK.PA", "PAR", "France", {
        longName: bondName,
        avgUsdVolume30d: 9e9,
      });
      const r = chooseCanonical([share, bond], "France", null, opts);
      expect(r.canonicalId).toBe(share.securityId);
      expect(r.roles[bond.securityId]).toBe("excluded");
    });
    it("a company that is only a bond is excluded (not_a_share)", () => {
      const bond = listing("ACALK.PA", "PAR", "France", { longName: bondName });
      const r = chooseCanonical([bond], "France", null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("not_a_share");
    });
    it("a listing whose quote type is not EQUITY is excluded", () => {
      const etf = listing("QQQ", "NMS", US, { quoteType: "ETF", avgUsdVolume30d: 9e9 });
      const r = chooseCanonical([etf], US, null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("not_a_share");
      expect(r.roles[etf.securityId]).toBe("excluded");
    });
    it("an unknown quote type is treated as a share (tests and old rows)", () => {
      const a = listing("AAA", "NYQ", US, { avgUsdVolume30d: 1e6 });
      expect(chooseCanonical([a], US, null, opts).canonicalId).toBe(a.securityId);
    });
  });
});

describe("main exchange for a company without a scanned home exchange (A-50 round 2)", () => {
  const opts = { switchRatio: 1.5 };
  const US = "United States";
  const us = (symbol: string, patch: Partial<ListingFact> = {}) =>
    listing(symbol, "NYQ", US, { currency: "USD", financialCurrency: "USD", ...patch });

  it("Accenture (Ireland, ordinary shares on NYSE, reports in USD): the NYSE line is canonical", () => {
    const acn = us("ACN", { longName: "Accenture plc", avgUsdVolume30d: 1e9 });
    const r = chooseCanonical([acn], "Ireland", null, opts);
    expect(r.canonicalId).toBe(acn.securityId);
    expect(r.exclusion).toBeNull();
  });

  it("the home listing still wins when it exists (Shell: SHEL.L over the NYSE line)", () => {
    const l = listing("SHEL.L", "LSE", "United Kingdom", { avgUsdVolume30d: 1e6 });
    const ny = us("SHEL", { avgUsdVolume30d: 9e9 });
    const r = chooseCanonical([l, ny], "United Kingdom", null, opts);
    expect(r.canonicalId).toBe(l.securityId);
    expect(r.roles[ny.securityId]).toBe("adr");
  });

  it.each([
    ["Novo Nordisk", "NVO", "Denmark", "DKK"],
    ["Nokia", "NOK", "Finland", "EUR"],
    ["Santander", "SAN", "Spain", "EUR"],
    ["PDD", "PDD", "China", "CNY"],
  ])(
    "%s: a US line that reports in a foreign currency is an ADR, never canonical",
    (_n, symbol, country, fin) => {
      const adr = us(symbol, { financialCurrency: fin, avgUsdVolume30d: 9e9 });
      const r = chooseCanonical([adr], country, null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("no_primary_listing");
      expect(r.roles[adr.securityId]).toBe("excluded");
    },
  );

  it.each([
    "Arm Holdings plc American Depositary Shares",
    "Foo Ltd Sponsored ADR",
    "Bar SA ADS",
    "Baz GDR",
  ])(
    "%s: an explicit depositary marker in the name makes it an ADR even when it reports in USD",
    (longName) => {
      const adr = us("XYZ", { longName });
      const r = chooseCanonical([adr], "Norway", null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("no_primary_listing");
    },
  );

  it("known residual error: an ADR that reports in USD and has no marker is read as ordinary shares (Equinor)", () => {
    const eqnr = us("EQNR", { longName: "Equinor ASA" });
    expect(chooseCanonical([eqnr], "Norway", null, opts).canonicalId).toBe(eqnr.securityId);
  });

  it("known residual error: ordinary shares that report in a foreign currency are read as an ADR (Spotify on NYSE)", () => {
    const spot = us("SPOT", { financialCurrency: "EUR", longName: "Spotify Technology S.A." });
    expect(chooseCanonical([spot], "Sweden", null, opts).exclusion).toBe("no_primary_listing");
  });

  it("only the US venues count as a main exchange: a Xetra, BDR or London line of a foreign company is never used", () => {
    const xetra = listing("NOA3.DE", "GER", "Germany", {
      currency: "EUR",
      financialCurrency: "EUR",
    });
    const bdr = listing("NOKI34.SA", "SAO", "Brazil", {
      currency: "BRL",
      financialCurrency: "EUR",
    });
    const lse = listing("TYT.L", "LSE", "United Kingdom", {
      currency: "GBP",
      financialCurrency: "JPY",
    });
    for (const l of [xetra, bdr, lse]) {
      const r = chooseCanonical([l], "Finland", null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("no_primary_listing");
    }
  });

  it("OTC lines are never a main exchange", () => {
    const otc = listing("ACNBY", "PNK", US, { venueClass: "otc" });
    expect(chooseCanonical([otc], "Ireland", null, opts).exclusion).toBe("no_primary_listing");
  });

  it("share classes on the main exchange compete on volume", () => {
    const a = us("BF-A", { avgUsdVolume30d: 1e6 });
    const b = us("BF-B", { avgUsdVolume30d: 5e8 });
    expect(chooseCanonical([a, b], "Ireland", null, opts).canonicalId).toBe(b.securityId);
  });

  it("an ADR canonical from an earlier scan is replaced by nothing: the company is excluded", () => {
    const adr = us("NVO", { financialCurrency: "DKK" });
    const r = chooseCanonical([adr], "Denmark", { securityId: adr.securityId }, opts);
    expect(r.canonicalId).toBeNull();
  });

  describe("country inference (all eligible listings in one country)", () => {
    it("Alphabet: GOOGL and GOOG on Nasdaq infer the United States", () => {
      const a = listing("GOOGL", "NMS", US, {
        currency: "USD",
        financialCurrency: "USD",
        avgUsdVolume30d: 9e9,
      });
      const b = listing("GOOG", "NMS", US, {
        currency: "USD",
        financialCurrency: "USD",
        avgUsdVolume30d: 8e9,
      });
      const r = chooseCanonical([a, b], null, null, opts);
      expect(r.canonicalId).toBe(a.securityId);
      expect(r.inferredCountry).toBe(US);
    });
    it("Alphabet with its cross-lines (Swiss, Canadian, German, Brazilian): the foreign-currency lines are ignored for the inference", () => {
      const a = listing("GOOGL", "NMS", US, {
        currency: "USD",
        financialCurrency: "USD",
        avgUsdVolume30d: 9e9,
      });
      const b = listing("GOOG", "NMS", US, {
        currency: "USD",
        financialCurrency: "USD",
        avgUsdVolume30d: 8e9,
      });
      const sw = listing("GOOGL.SW", "EBS", "Switzerland", {
        currency: "CHF",
        financialCurrency: "USD",
        avgUsdVolume30d: 1e6,
      });
      const to = listing("GOOG.TO", "TOR", "Canada", { currency: "CAD", financialCurrency: "USD" });
      const de = listing("ABEC.DE", "GER", "Germany", {
        currency: "EUR",
        financialCurrency: "USD",
      });
      const br = listing("GOGL34.SA", "SAO", "Brazil", {
        currency: "BRL",
        financialCurrency: "USD",
      });
      const r = chooseCanonical([a, b, sw, to, de, br], null, null, opts);
      expect(r.canonicalId).toBe(a.securityId);
      for (const l of [sw, to, de]) expect(r.roles[l.securityId]).toBe("foreign_listing");
      expect(r.roles[br.securityId]).toBe("secondary_venue"); // a BDR
    });
    it("two lines in different countries and no way to tell: country_unknown", () => {
      const a = listing("ABC.SW", "EBS", "Switzerland", {
        currency: "CHF",
        financialCurrency: "CHF",
      });
      const b = listing("ABC", "NYQ", US, { currency: "USD", financialCurrency: "USD" });
      expect(chooseCanonical([a, b], null, null, opts).exclusion).toBe("country_unknown");
    });
    it("a single US line that looks like an ADR does not give a home country", () => {
      const adr = listing("NVO", "NYQ", US, { currency: "USD", financialCurrency: "DKK" });
      const r = chooseCanonical([adr], null, null, opts);
      expect(r.canonicalId).toBeNull();
      expect(r.exclusion).toBe("country_unknown");
    });
  });
});

describe("BDR and fund lines (A-50 round 2)", () => {
  const opts = { switchRatio: 1.5 };
  it("Nu Holdings: the Brazilian BDR is never the home listing, the NYSE ordinary shares are canonical", () => {
    const bdr = listing("ROXO34.SA", "SAO", "Brazil", {
      currency: "BRL",
      financialCurrency: "USD",
      avgUsdVolume30d: 9e9,
    });
    const nu = listing("NU", "NYQ", "United States", {
      currency: "USD",
      financialCurrency: "USD",
      avgUsdVolume30d: 1e8,
    });
    const r = chooseCanonical([bdr, nu], "Brazil", null, opts);
    expect(r.canonicalId).toBe(nu.securityId);
    expect(r.roles[bdr.securityId]).toBe("secondary_venue");
  });
  it("a fund that Yahoo labels EQUITY is excluded (not_a_share)", () => {
    const etf = listing("VEU.AX", "ASX", "Australia", {
      longName: "Vanguard All-World ex-US Shares Index ETF",
    });
    const r = chooseCanonical([etf], null, null, opts);
    expect(r.canonicalId).toBeNull();
    expect(r.exclusion).toBe("not_a_share");
  });
});
