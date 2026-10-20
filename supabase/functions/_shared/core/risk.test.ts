import { describe, expect, it } from "vitest";
import {
  buildChangeUser,
  CHANGE_CLASSIFICATION_SCHEMA,
  CHANGE_SYSTEM,
  type ChangeItem,
  computeDelta,
  findingAction,
  fingerprintInput,
  type ItemLike,
  isEmptyDelta,
  isFirstObservation,
  MATERIAL_CRITERIA,
  matchKeywords,
  mergeSeen,
  NEWS_KEYWORDS,
  strongestKeyword,
  validateChangeOutput,
} from "./risk.ts";

const item = (id: string, title: string, over: Partial<ItemLike> = {}): ItemLike => ({
  id,
  title,
  link: `https://x.example/${id}`,
  publishedAt: "2026-10-14T00:00:00.000Z",
  ...over,
});

describe("keyword filter (A-29)", () => {
  it("lists the fifteen keywords of spec 9.7, strongest first", () => {
    expect(NEWS_KEYWORDS).toHaveLength(15);
    expect(NEWS_KEYWORDS[0]).toBe("going concern");
  });
  it("matches whole words with common suffixes, case-insensitively", () => {
    expect(matchKeywords("Moody's DOWNGRADED Acme after covenant waiver")).toEqual([
      "covenant",
      "downgrade",
    ]);
    expect(matchKeywords("Regulators probe Acme; lawsuits follow")).toEqual(["probe", "lawsuit"]);
    expect(matchKeywords("Profit warning issued")).toEqual(["profit warning"]);
    expect(matchKeywords("Acme launches a new product")).toEqual([]);
    expect(matchKeywords("A problem with the website")).toEqual([]);
  });
  it("picks the strongest keyword", () => {
    expect(strongestKeyword(["guidance", "bankruptcy"])).toBe("bankruptcy");
    expect(strongestKeyword([])).toBeNull();
  });
});

describe("computeDelta", () => {
  const latest = {
    edgar: [
      item("a1", "8-K filed", { form: "8-K" }),
      item("a2", "SC 13G filed", { form: "SC 13G" }),
      item("a3", "10-Q filed", { form: "10-Q" }),
    ],
    rss: [item("r1", "Press release"), item("r2", "Another release")],
    yahoo: [item("y1", "Acme downgrade looms"), item("y2", "Acme opens new store")],
  };
  it("counts new watch-form filings, any new RSS item, and keyword-matching Yahoo titles", () => {
    const d = computeDelta({ edgar: ["a3"], rss: ["r2"], yahoo: [] }, latest);
    expect(d.edgar.map((i) => i.id)).toEqual(["a1"]);
    expect(d.rss.map((i) => i.id)).toEqual(["r1"]);
    expect(d.yahoo.map((i) => i.id)).toEqual(["y1"]);
    expect(d.keywords).toEqual(["downgrade"]);
    expect(isEmptyDelta(d)).toBe(false);
  });
  it("is empty when everything was seen or irrelevant", () => {
    const d = computeDelta({ edgar: ["a1", "a2", "a3"], rss: ["r1", "r2"], yahoo: ["y1"] }, latest);
    expect(isEmptyDelta(d)).toBe(true);
    expect(isEmptyDelta(computeDelta({}, { yahoo: [item("y2", "Acme opens new store")] }))).toBe(
      true,
    );
  });
  it("detects a first observation and merges seen ids with a cap", () => {
    expect(isFirstObservation({})).toBe(true);
    expect(isFirstObservation({ edgar: [] })).toBe(true);
    expect(isFirstObservation({ edgar: ["a"] })).toBe(false);
    const merged = mergeSeen({ edgar: ["a", "b"] }, latest, 4);
    expect(merged.edgar).toEqual(["b", "a1", "a2", "a3"]);
    expect(merged.rss).toEqual(["r1", "r2"]);
  });
});

describe("classification prompt, schema and validation", () => {
  it("states the six material-change categories and the fixed output schema", () => {
    for (const c of [
      "liquidity_debt",
      "credit_rating",
      "accounting_audit",
      "regulatory_legal",
      "guidance",
      "governance",
    ]) {
      expect(MATERIAL_CRITERIA).toContain(c);
      expect(CHANGE_SYSTEM).toContain(c);
    }
    expect(CHANGE_CLASSIFICATION_SCHEMA.required).toEqual([
      "material",
      "category",
      "severity",
      "summary",
      "evidence_ids",
    ]);
    expect(CHANGE_CLASSIFICATION_SCHEMA.additionalProperties).toBe(false);
  });

  it("keeps the user message inside 4k tokens and numbers the items", () => {
    const items: ChangeItem[] = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      kind: "rss",
      title: `Item ${i + 1}`,
      date: "2026-10-14",
      excerpt: "x".repeat(2000),
      primary: true,
      url: `https://x.example/${i}`,
    }));
    const text = buildChangeUser({
      company: "Acme",
      ticker: "ACME",
      previous: { category: "green", summary: "Stable.", date: "2026-09-20" },
      items,
    });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain("[E1]");
    expect(text).toContain("PREVIOUS ASSESSMENT: category=green");
    expect(text).toMatch(/further items omitted/);
    expect(
      buildChangeUser({ company: "Acme", ticker: "ACME", previous: null, items: [] }),
    ).toContain("PREVIOUS ASSESSMENT: none");
  });

  it("accepts a valid answer and rejects unknown ids, categories and shapes", () => {
    const good = {
      material: true,
      category: "liquidity_debt",
      severity: "material",
      summary: "Going concern doubt.",
      evidence_ids: [1],
    };
    expect(validateChangeOutput(good, [1, 2])).toEqual({ ok: true, output: good });
    expect(validateChangeOutput({ ...good, evidence_ids: [9] }, [1, 2]).ok).toBe(false);
    expect(validateChangeOutput({ ...good, category: "weather" }, [1]).ok).toBe(false);
    expect(validateChangeOutput({ ...good, summary: "" }, [1]).ok).toBe(false);
    expect(validateChangeOutput("nope", [1]).ok).toBe(false);
    expect(validateChangeOutput({ ...good, material: true, evidence_ids: [] }, [1]).ok).toBe(false);
  });
});

describe("findings", () => {
  it("fingerprint input is the category plus the sorted, de-duplicated canonical URLs", () => {
    expect(
      fingerprintInput("liquidity_debt", [
        "https://b.example/2",
        "https://a.example/1",
        "https://b.example/2",
      ]),
    ).toBe("liquidity_debt\nhttps://a.example/1\nhttps://b.example/2");
    expect(fingerprintInput("guidance", [])).toBe("guidance\n");
  });
  it("updates an open finding when there is no new primary-source evidence, otherwise inserts", () => {
    expect(findingAction(null, ["https://a.example/1"])).toBe("insert");
    expect(findingAction({ primaryUrls: ["https://a.example/1"] }, ["https://a.example/1"])).toBe(
      "update",
    );
    expect(findingAction({ primaryUrls: ["https://a.example/1"] }, [])).toBe("update");
    expect(findingAction({ primaryUrls: ["https://a.example/1"] }, ["https://a.example/2"])).toBe(
      "insert",
    );
  });
});
