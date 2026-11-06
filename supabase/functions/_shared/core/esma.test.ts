import { describe, expect, it } from "vitest";
import {
  firdsHasMatch,
  firdsQuery,
  firdsSolrQ,
  firdsSolrUrl,
  firstFirdsMatch,
  hasExchangeSegment,
  isValidIsin,
  normalizeIsin,
  parseEsmaDocs,
  pickRegulatedSegments,
  solrValue,
  venuesQueryByLei,
  venuesQueryByMic,
  venuesSolrUrlByLei,
  venuesSolrUrlByMic,
} from "./esma.ts";
import { EU_EXCHANGES, findEuExchange } from "./eu-exchanges.ts";

describe("isValidIsin", () => {
  it("accepts real ISINs", () => {
    for (const s of ["IE00BMFKG444", "US0378331005", "DE0005140008"])
      expect(isValidIsin(s)).toBe(true);
  });
  it("rejects a wrong check digit, bad shape and lowercase", () => {
    expect(isValidIsin("IE00BMFKG445")).toBe(false);
    expect(isValidIsin("US037833100")).toBe(false);
    expect(isValidIsin("1E00BMFKG444")).toBe(false);
    expect(isValidIsin("ie00bmfkg444")).toBe(false);
    expect(isValidIsin("")).toBe(false);
  });
});

describe("normalizeIsin", () => {
  it("trims and uppercases", () => {
    expect(normalizeIsin("  ie00bmfkg444 ")).toBe("IE00BMFKG444");
  });
});

describe("query builders", () => {
  it("builds the venues query by LEI and by MIC", () => {
    const q = venuesQueryByLei("391200OUOEWDQSEJ0Y74");
    expect(q.core).toBe("esma_registers_upreg");
    expect(q.criteria).toEqual([
      { name: "ae_lei", value: "391200OUOEWDQSEJ0Y74", type: "text", isParent: true },
    ]);
    expect(venuesQueryByMic("XAMS").criteria).toEqual([
      { name: "ae_micLeiEsmaId", value: "XAMS", type: "text", isParent: true },
    ]);
  });
  it("builds the FIRDS query with the latest-publication filter", () => {
    const q = firdsQuery("IE00BMFKG444", "XETA") as { criteria: { name: string; value: string }[] };
    expect(q.criteria.map((c) => [c.name, c.value])).toEqual([
      ["isin", "IE00BMFKG444"],
      ["mic", "XETA"],
      ["firdsPublicationDateCustomSearchInputField", "(latest_received_flag:1)"],
    ]);
  });
});

const doc = (mic: string, name: string, label = "Regulated market", status = "Active") => ({
  ae_micLeiEsmaId: mic,
  ae_entityName: name,
  ae_entityTypeLabel: label,
  ae_status: status,
});

describe("pickRegulatedSegments", () => {
  const xetr = findEuExchange("XETR");
  if (!xetr) throw new Error("XETR missing from EU_EXCHANGES");

  it("keeps only the exchange's own regulated segments, off-book last, deduped", () => {
    const docs = [
      doc("FRAA", "Börse Frankfurt"),
      doc("XETU", "Xetra Off-Book"),
      doc("XETA", "Xetra"),
      doc("XETA", "Xetra again"),
      doc("XEMA", "Xetra Main"),
      doc("XETB", "Xetra MTF", "Multilateral trading facility"),
      doc("XETS", "Xetra Inactive", "Regulated market", "Withdrawn"),
    ];
    expect(pickRegulatedSegments(docs, xetr)).toEqual([
      { mic: "XETA", name: "Xetra" },
      { mic: "XEMA", name: "Xetra Main" },
      { mic: "XETU", name: "Xetra Off-Book" },
    ]);
  });
  it("matches MICs exactly, not by substring", () => {
    expect(pickRegulatedSegments([doc("XETAX", "x")], xetr)).toEqual([]);
  });
  it("hasExchangeSegment ignores entity type", () => {
    expect(hasExchangeSegment([doc("XETB", "m", "Multilateral trading facility")], xetr)).toBe(
      true,
    );
    expect(hasExchangeSegment([doc("FRAA", "f")], xetr)).toBe(false);
  });
});

describe("firdsHasMatch", () => {
  const docs = [
    { isin: "IE00BMFKG444", mic: "XETB", gnr_full_name: "other" },
    { isin: "IE00BMFKG4440", mic: "XETA" },
    { isin: "IE00BMFKG444", mic: "XETA", gnr_full_name: "Fund" },
  ];
  it("requires exact ISIN and MIC", () => {
    expect(firdsHasMatch(docs, "IE00BMFKG444", "XETA")?.gnr_full_name).toBe("Fund");
    expect(firdsHasMatch(docs, "IE00BMFKG444", "XETU")).toBeUndefined();
  });
});

describe("EU_EXCHANGES", () => {
  it("looks up case-insensitively, resolves segments, and has the key venues", () => {
    expect(findEuExchange("xetr")?.name).toBe("Deutsche Börse Xetra");
    expect(findEuExchange("XMAD")?.mic).toBe("BMEX");
    expect(findEuExchange("NOPE")).toBeUndefined();
    expect(EU_EXCHANGES.length).toBeGreaterThan(50);
    expect(findEuExchange("XETR")?.segments).toContain("XETA");
  });
});

describe("Solr select builders", () => {
  it("builds the exact-field FIRDS q and URL", () => {
    expect(firdsSolrQ("IE00BMFKG444", ["XETA", "XETU"])).toBe(
      "isin:IE00BMFKG444 AND latest_received_flag:1 AND mic:(XETA OR XETU)",
    );
    const url = new URL(firdsSolrUrl("IE00BMFKG444", ["XETA", "XEMA"]));
    expect(url.pathname).toBe("/solr/esma_registers_firds/select");
    expect(url.searchParams.get("q")).toBe(
      "isin:IE00BMFKG444 AND latest_received_flag:1 AND mic:(XETA OR XEMA)",
    );
    expect(url.searchParams.get("wt")).toBe("json");
    expect(url.searchParams.get("rows")).toBe("50");
    expect(url.searchParams.get("fl")).toBe("isin,mic,gnr_full_name,mrkt_trdng_start_date");
  });
  it("builds the venues URLs by LEI and MIC", () => {
    const a = new URL(venuesSolrUrlByLei("391200OUOEWDQSEJ0Y74"));
    expect(a.pathname).toBe("/solr/esma_registers_upreg/select");
    expect(a.searchParams.get("q")).toBe("ae_lei:391200OUOEWDQSEJ0Y74");
    expect(a.searchParams.get("rows")).toBe("100");
    expect(new URL(venuesSolrUrlByMic("XAMS")).searchParams.get("q")).toBe("ae_micLeiEsmaId:XAMS");
  });
  it("only lets [A-Z0-9] into a q string", () => {
    expect(() => solrValue("AB 12")).toThrow();
    expect(() => solrValue("a*")).toThrow();
    expect(() => solrValue("")).toThrow();
    expect(() => firdsSolrQ("IE00BMFKG444", ["XETA) OR (isin:*"])).toThrow();
    expect(() => firdsSolrQ("IE00BMFKG444", [])).toThrow();
    expect(() => venuesSolrUrlByLei("X OR *")).toThrow();
  });
});

describe("parseEsmaDocs", () => {
  it("returns docs, and null for HTML or an unexpected shape", () => {
    expect(parseEsmaDocs('{"response":{"docs":[{"a":1},3]}}')).toEqual([{ a: 1 }]);
    expect(parseEsmaDocs("<html>captcha</html>")).toBeNull();
    expect(parseEsmaDocs('{"response":{}}')).toBeNull();
    expect(parseEsmaDocs("null")).toBeNull();
  });
});

describe("firstFirdsMatch", () => {
  it("picks the first segment in try order with an exact match", () => {
    const segs = [
      { mic: "XETA", name: "a" },
      { mic: "XEMA", name: "b" },
    ];
    const docs = [
      { isin: "IE00BMFKG444", mic: "XEMA", gnr_full_name: "n" },
      { isin: "OTHER", mic: "XETA" },
    ];
    expect(firstFirdsMatch(docs, "IE00BMFKG444", segs)?.segment.mic).toBe("XEMA");
    expect(firstFirdsMatch([], "IE00BMFKG444", segs)).toBeUndefined();
  });
});
