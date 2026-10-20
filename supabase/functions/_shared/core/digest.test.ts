import { describe, expect, it } from "vitest";
import {
  buildDiscountDigest,
  buildPortfolioDigest,
  canonicalJson,
  type DiscountEntry,
  orderDiscountEntries,
  type PortfolioEntryView,
  PUSH_PAYLOAD_MAX_BYTES,
  pushPayload,
  utf8Length,
} from "./digest.ts";

function discount(over: Partial<DiscountEntry> = {}): DiscountEntry {
  return {
    episodeId: "ep-1",
    companyId: "co-1",
    securityId: "sec-1",
    mode: "worldwide",
    alsoIn: [],
    rank: 12,
    yahooSymbol: "AAA",
    name: "Alpha Corp",
    close: 101.5,
    ccy: "USD",
    sessionDate: "2026-10-14",
    line: "-3",
    isTop10: false,
    reachedLine4: false,
    category: "green",
    conclusion: "Meets these two fundamental checks.",
    bankruptcyRisk: "Low",
    summary: "Shares fell after a sector sell-off.",
    eur: null,
    ...over,
  };
}

function portfolio(over: Partial<PortfolioEntryView> = {}): PortfolioEntryView {
  return {
    key: "sec-9",
    securityId: "sec-9",
    yahooSymbol: "ZZZ",
    name: "Zeta plc",
    priceSignals: [],
    riskFindingIds: [],
    researchStatus: "complete",
    signals: [],
    risks: [],
    ...over,
  };
}

describe("orderDiscountEntries", () => {
  it("puts green before amber, then rank ascending, then symbol ascending", () => {
    const ordered = orderDiscountEntries([
      discount({ episodeId: "a", yahooSymbol: "AMB1", category: "amber", rank: 1 }),
      discount({ episodeId: "b", yahooSymbol: "GRN9", rank: 9 }),
      discount({ episodeId: "c", yahooSymbol: "GRN2B", rank: 2 }),
      discount({ episodeId: "d", yahooSymbol: "GRN2A", rank: 2 }),
    ]);
    expect(ordered.map((e) => e.episodeId)).toEqual(["d", "c", "b", "a"]);
  });

  it("uses code-unit order for symbols (uppercase before lowercase) and does not mutate the input", () => {
    const input = [
      discount({ episodeId: "x", yahooSymbol: "a", rank: 1 }),
      discount({ episodeId: "y", yahooSymbol: "B", rank: 1 }),
    ];
    expect(orderDiscountEntries(input).map((e) => e.episodeId)).toEqual(["y", "x"]);
    expect(input.map((e) => e.episodeId)).toEqual(["x", "y"]);
  });
});

describe("buildDiscountDigest", () => {
  it("accepts any research outcome, or none, because newness on the list decides (spec 5.12)", () => {
    const entries = ["green", "amber", "red", "grey", null].map((category, i) =>
      discount({
        episodeId: `e${i}`,
        companyId: `c${i}`,
        rank: i + 1,
        category: category as DiscountEntry["category"],
      }),
    );
    const built = buildDiscountDigest(entries, { modes: ["worldwide"], sendEmpty: false });
    expect(built.items.map((e) => e.episodeId)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });

  it("orders green, amber, then other outcomes, then not researched", () => {
    const ordered = orderDiscountEntries([
      discount({ episodeId: "none", category: null, rank: 1 }),
      discount({ episodeId: "red", category: "red", rank: 2 }),
      discount({ episodeId: "amber", category: "amber", rank: 3 }),
      discount({ episodeId: "green", category: "green", rank: 4 }),
    ]);
    expect(ordered.map((e) => e.episodeId)).toEqual(["green", "amber", "red", "none"]);
  });

  it("skips an empty digest with reason empty unless sendEmpty", () => {
    expect(buildDiscountDigest([], { modes: ["worldwide"], sendEmpty: false })).toEqual({
      items: [],
      skipReason: "empty",
    });
    expect(buildDiscountDigest([], { modes: ["worldwide"], sendEmpty: true })).toEqual({
      items: [],
      skipReason: null,
    });
  });

  it("restricts to the user's modes (a us-only discount does not notify a worldwide user)", () => {
    const rows = [discount({ mode: "us", episodeId: "us-1" })];
    expect(buildDiscountDigest(rows, { modes: ["worldwide"], sendEmpty: false }).skipReason).toBe(
      "empty",
    );
    expect(
      buildDiscountDigest(rows, { modes: ["worldwide", "us"], sendEmpty: false }).items,
    ).toHaveLength(1);
  });

  it("merges one entry per company: primary is the first mode of worldwide, us; the other goes to alsoIn", () => {
    const rows = [
      discount({ mode: "us", episodeId: "us-ep", rank: 9, line: "-3" }),
      discount({ mode: "worldwide", episodeId: "ww-ep", rank: 14 }),
    ];
    const { items } = buildDiscountDigest(rows, { modes: ["us", "worldwide"], sendEmpty: false });
    expect(items).toHaveLength(1);
    expect(items[0]?.episodeId).toBe("ww-ep");
    expect(items[0]?.mode).toBe("worldwide");
    expect(items[0]?.alsoIn).toEqual(["us"]);
  });

  it("a user with only the us mode gets the us entry as primary", () => {
    const rows = [
      discount({ mode: "us", episodeId: "us-ep" }),
      discount({ mode: "worldwide", episodeId: "ww-ep" }),
    ];
    const { items } = buildDiscountDigest(rows, { modes: ["us"], sendEmpty: false });
    expect(items.map((e) => e.episodeId)).toEqual(["us-ep"]);
    expect(items[0]?.alsoIn).toEqual([]);
  });

  it("orders merged entries green then amber", () => {
    const rows = [
      discount({
        companyId: "c1",
        episodeId: "amber",
        category: "amber",
        rank: 1,
        yahooSymbol: "A",
      }),
      discount({ companyId: "c2", episodeId: "green", rank: 50, yahooSymbol: "G" }),
    ];
    const { items } = buildDiscountDigest(rows, { modes: ["worldwide"], sendEmpty: false });
    expect(items.map((e) => e.episodeId)).toEqual(["green", "amber"]);
  });
});

describe("buildPortfolioDigest", () => {
  it("combines a new premium event and a new risk finding of one holding into one entry", () => {
    const premium = portfolio({
      priceSignals: ["premium1"],
      signals: [{ kind: "premium1", close: 12.3, ccy: "USD", sessionDate: "2026-10-14" }],
    });
    const risk = portfolio({
      riskFindingIds: ["f-1"],
      risks: [
        {
          id: "f-1",
          category: "liquidity_debt",
          summary: "Covenant breach disclosed.",
          detectedOn: "2026-10-14",
        },
      ],
    });
    const { items } = buildPortfolioDigest([premium, risk], false);
    expect(items).toHaveLength(1);
    expect(items[0]?.priceSignals).toEqual(["premium1"]);
    expect(items[0]?.riskFindingIds).toEqual(["f-1"]);
    expect(items[0]?.signals).toHaveLength(1);
    expect(items[0]?.risks).toHaveLength(1);
  });

  it("is idempotent when the same finding is passed twice", () => {
    const risk = portfolio({
      riskFindingIds: ["f-1"],
      risks: [{ id: "f-1", category: "other", summary: "x", detectedOn: "2026-10-14" }],
    });
    const { items } = buildPortfolioDigest([risk, risk], false);
    expect(items[0]?.riskFindingIds).toEqual(["f-1"]);
    expect(items[0]?.risks).toHaveLength(1);
  });

  it("orders by symbol and applies the empty rule", () => {
    const { items } = buildPortfolioDigest(
      [portfolio({ key: "b", yahooSymbol: "BBB" }), portfolio({ key: "a", yahooSymbol: "AAA" })],
      false,
    );
    expect(items.map((e) => e.yahooSymbol)).toEqual(["AAA", "BBB"]);
    expect(buildPortfolioDigest([], false)).toEqual({ items: [], skipReason: "empty" });
    expect(buildPortfolioDigest([], true)).toEqual({ items: [], skipReason: null });
  });
});

describe("canonicalJson", () => {
  it("is independent of key order, has no whitespace and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("drops undefined values like JSON and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("the push body of a discount (A-51: rank decides only the tag)", () => {
  it("the push body counts the strong buys", () => {
    const rows = [
      discount({ episodeId: "a", companyId: "ca", rank: 2, yahooSymbol: "AA", isTop10: true }),
      discount({ episodeId: "b", companyId: "cb", rank: 30, yahooSymbol: "BB" }),
    ];
    expect(pushPayload("discounts", rows, "https://s.example").body).toBe(
      "2 new discounts: #2 AA, #30 BB (1 strong buy)",
    );
    expect(pushPayload("discounts", [rows[1] as DiscountEntry], "https://s.example").body).toBe(
      "1 new discount: #30 BB",
    );
  });
});

describe("pushPayload", () => {
  it("builds a compact payload with a same-site url and the per-kind tag", () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      discount({ episodeId: `e${n}`, companyId: `c${n}`, rank: n, yahooSymbol: `S${n}` }),
    );
    const payload = pushPayload("discounts", rows, "https://s.example/");
    expect(payload.url).toBe("https://s.example/");
    expect(payload.tag).toBe("digest-discounts");
    expect(payload.body).toBe("5 new discounts: #1 S1, #2 S2, #3 S3, +2 more");
    expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"]);
    expect(
      pushPayload("portfolio", [portfolio({ priceSignals: ["premium1"] })], "https://s.example")
        .url,
    ).toBe("https://s.example/portfolio");
  });

  it("never exceeds 3,500 bytes: the body is truncated", () => {
    const huge = discount({ yahooSymbol: "X".repeat(6000), name: "é".repeat(100) });
    const payload = pushPayload("discounts", [huge], "https://s.example", { maxBodyChars: 10_000 });
    const bytes = utf8Length(JSON.stringify(payload));
    expect(bytes).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
    expect(payload.body.endsWith("…")).toBe(true);
  });

  it("describes an empty digest (send_empty) instead of listing nothing", () => {
    expect(pushPayload("discounts", [], "https://s.example").body).toBe("No new discounts today");
  });

  it("caps the body at 140 characters by default", () => {
    const long = discount({ yahooSymbol: "Y".repeat(500) });
    expect(pushPayload("discounts", [long], "https://s.example").body.length).toBeLessThanOrEqual(
      140,
    );
  });
});
