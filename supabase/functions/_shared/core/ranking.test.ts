import { describe, expect, it } from "vitest";
import {
  isUsExchange,
  isUsPrimary,
  mergeModesForNotification,
  type RankCandidate,
  rankUniverse,
} from "./ranking.ts";

const cand = (symbol: string, cap: number, us = false, company = symbol): RankCandidate => ({
  securityId: `sec-${symbol}`,
  companyId: `co-${company}`,
  yahooSymbol: symbol,
  marketCapUsd: cap,
  isUsPrimary: us,
});

describe("rankUniverse", () => {
  it("sorts descending by market cap with unique ranks 1..N", () => {
    const rows = rankUniverse([cand("B", 200e9), cand("A", 300e9), cand("C", 100e9)], "worldwide");
    expect(rows.map((r) => [r.yahooSymbol, r.rank])).toEqual([
      ["A", 1],
      ["B", 2],
      ["C", 3],
    ]);
    expect(new Set(rows.map((r) => r.rank)).size).toBe(3);
  });

  it("breaks ties ascending by yahooSymbol in code-unit order (uppercase before lowercase, digits before letters)", () => {
    const rows = rankUniverse(
      [cand("b", 100e9), cand("B", 100e9), cand("0700.HK", 100e9), cand("A", 100e9)],
      "worldwide",
    );
    expect(rows.map((r) => r.yahooSymbol)).toEqual(["0700.HK", "A", "B", "b"]);
  });

  it("is deterministic regardless of input order", () => {
    const input = [cand("X", 5e11), cand("Y", 5e11), cand("Z", 4e11), cand("W", 6e11)];
    const a = rankUniverse(input, "worldwide").map((r) => r.yahooSymbol);
    const b = rankUniverse([...input].reverse(), "worldwide").map((r) => r.yahooSymbol);
    expect(a).toEqual(b);
  });

  it("marks isTop10 for ranks 1..10 only (rank 10 true, rank 11 false)", () => {
    const members = Array.from({ length: 12 }, (_, i) =>
      cand(`S${String(i).padStart(2, "0")}`, (100 - i) * 1e9),
    );
    const rows = rankUniverse(members, "worldwide");
    expect(rows[9]?.rank).toBe(10);
    expect(rows[9]?.isTop10).toBe(true);
    expect(rows[10]?.rank).toBe(11);
    expect(rows[10]?.isTop10).toBe(false);
  });

  it("us mode ranks only US-primary members and renumbers from 1", () => {
    const members = [
      cand("TSM", 900e9, false),
      cand("AAPL", 800e9, true),
      cand("MSFT", 700e9, true),
    ];
    expect(rankUniverse(members, "us").map((r) => [r.yahooSymbol, r.rank])).toEqual([
      ["AAPL", 1],
      ["MSFT", 2],
    ]);
    expect(rankUniverse(members, "worldwide").map((r) => [r.yahooSymbol, r.rank])).toEqual([
      ["TSM", 1],
      ["AAPL", 2],
      ["MSFT", 3],
    ]);
  });

  it("does not mutate its input and handles an empty universe", () => {
    const input = [cand("B", 1), cand("A", 2)];
    rankUniverse(input, "worldwide");
    expect(input.map((c) => c.yahooSymbol)).toEqual(["B", "A"]);
    expect(rankUniverse([], "us")).toEqual([]);
  });
});

describe("isUsExchange", () => {
  it.each([
    ["NMS", true],
    ["NYQ", true],
    ["NGM", true],
    ["GER", false],
    ["PNK", false],
    ["TOR", false],
  ] as const)("%s -> %s", (code, expected) => {
    expect(isUsExchange(code)).toBe(expected);
  });
});

describe("isUsPrimary", () => {
  const us = {
    canonicalExchange: "NMS",
    financialCurrency: "USD",
    homeCountry: "United States",
    hasHigherVolumeHomeListing: false,
    override: null,
  } as const;
  it("is true for a plain US company", () => {
    expect(isUsPrimary(us)).toBe(true);
  });
  it("is true when the home country is unknown", () => {
    expect(isUsPrimary({ ...us, homeCountry: null })).toBe(true);
  });
  it("excludes an ADR through financialCurrency (TSM reports in TWD)", () => {
    expect(
      isUsPrimary({
        ...us,
        canonicalExchange: "NYQ",
        financialCurrency: "TWD",
        homeCountry: "Taiwan",
      }),
    ).toBe(false);
  });
  it("excludes a Shopify-like US listing of a foreign company (USD reporter, non-US country)", () => {
    expect(isUsPrimary({ ...us, canonicalExchange: "NYQ", homeCountry: "Canada" })).toBe(false);
  });
  it("excludes a company whose home listing outside the US trades more", () => {
    expect(isUsPrimary({ ...us, hasHigherVolumeHomeListing: true })).toBe(false);
  });
  it("excludes non-US exchanges", () => {
    expect(isUsPrimary({ ...us, canonicalExchange: "GER" })).toBe(false);
    expect(isUsPrimary({ ...us, canonicalExchange: "PNK" })).toBe(false);
  });
  it("lets an override win in both directions", () => {
    expect(
      isUsPrimary({
        ...us,
        canonicalExchange: "NYQ",
        financialCurrency: "TWD",
        homeCountry: "Taiwan",
        override: "force_us",
      }),
    ).toBe(true);
    expect(isUsPrimary({ ...us, override: "force_not_us" })).toBe(false);
  });
});

describe("mergeModesForNotification", () => {
  it("returns one entry per company with the first mode of modeOrder as primary", () => {
    const members = [
      cand("AAPL", 800e9, true),
      cand("MSFT", 700e9, true),
      cand("TSM", 900e9, false),
    ];
    const rows = [...rankUniverse(members, "us"), ...rankUniverse(members, "worldwide")];
    const merged = mergeModesForNotification(rows, ["worldwide", "us"]);
    expect(merged).toHaveLength(3);
    const aapl = merged.find((m) => m.primary.yahooSymbol === "AAPL");
    expect(aapl?.primary.mode).toBe("worldwide");
    expect(aapl?.alsoIn).toEqual(["us"]);
    const tsm = merged.find((m) => m.primary.yahooSymbol === "TSM");
    expect(tsm?.alsoIn).toEqual([]);
  });

  it("picks us as primary when the company only has a us row or when us comes first", () => {
    const only = rankUniverse([cand("AAPL", 1e11, true)], "us");
    expect(mergeModesForNotification(only)[0]?.primary.mode).toBe("us");
    const both = [
      ...rankUniverse([cand("AAPL", 1e11, true)], "worldwide"),
      ...rankUniverse([cand("AAPL", 1e11, true)], "us"),
    ];
    expect(mergeModesForNotification(both, ["us", "worldwide"])[0]?.alsoIn).toEqual(["worldwide"]);
  });

  it("orders entries by primary rank then symbol", () => {
    const rows = rankUniverse([cand("B", 2e11), cand("A", 3e11), cand("C", 1e11)], "worldwide");
    expect(mergeModesForNotification(rows).map((m) => m.primary.yahooSymbol)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});
