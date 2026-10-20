import { describe, expect, it } from "vitest";
import { classifyOperational, type ResearchFacts } from "./classify.ts";

const MEETS = "Meets these two fundamental checks." as const;
const FAILS = "Does not meet one or both checks." as const;
const INSUFFICIENT = "Insufficient evidence to decide." as const;

const complete = (patch: Partial<ResearchFacts>): ResearchFacts => ({
  status: "complete",
  conclusion: MEETS,
  bankruptcyRisk: "Low",
  materialDamageEstablished: false,
  sufficientEvidence: true,
  ...patch,
});

describe("classifyOperational: one test per row of the 4.8 table", () => {
  it("row 1: no report -> pending research_pending", () => {
    expect(classifyOperational(null)).toEqual({
      category: "pending",
      reasonCode: "research_pending",
    });
  });
  it.each(["queued", "running", "stale"] as const)(
    "row 1: status %s -> pending research_pending",
    (status) => {
      expect(
        classifyOperational({
          status,
          conclusion: null,
          bankruptcyRisk: null,
          materialDamageEstablished: null,
          sufficientEvidence: null,
        }),
      ).toEqual({
        category: "pending",
        reasonCode: "research_pending",
      });
    },
  );
  it("row 1: quota_deferred -> pending research_quota_deferred", () => {
    expect(
      classifyOperational({
        status: "quota_deferred",
        conclusion: null,
        bankruptcyRisk: null,
        materialDamageEstablished: null,
        sufficientEvidence: null,
      }),
    ).toEqual({
      category: "pending",
      reasonCode: "research_quota_deferred",
    });
  });
  it("row 2: failed -> grey research_failed", () => {
    expect(
      classifyOperational({
        status: "failed",
        conclusion: null,
        bankruptcyRisk: null,
        materialDamageEstablished: null,
        sufficientEvidence: null,
      }),
    ).toEqual({
      category: "grey",
      reasonCode: "research_failed",
    });
  });
  it("row 3: High bankruptcy risk -> red bankruptcy_high, even when the conclusion says Meets", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "High" }))).toEqual({
      category: "red",
      reasonCode: "bankruptcy_high",
    });
  });
  it("row 4: material damage established -> red material_damage", () => {
    expect(classifyOperational(complete({ materialDamageEstablished: true }))).toEqual({
      category: "red",
      reasonCode: "material_damage",
    });
  });
  it("row 5: Unclear risk, insufficient evidence flag or insufficient conclusion -> grey inconclusive", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Unclear" }))).toEqual({
      category: "grey",
      reasonCode: "inconclusive",
    });
    expect(classifyOperational(complete({ sufficientEvidence: false }))).toEqual({
      category: "grey",
      reasonCode: "inconclusive",
    });
    expect(classifyOperational(complete({ conclusion: INSUFFICIENT }))).toEqual({
      category: "grey",
      reasonCode: "inconclusive",
    });
  });
  it("row 6: conclusion Does not meet -> red does_not_meet", () => {
    expect(classifyOperational(complete({ conclusion: FAILS }))).toEqual({
      category: "red",
      reasonCode: "does_not_meet",
    });
  });
  it("row 7: Moderate risk with clean checks -> amber moderate_risk", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Moderate" }))).toEqual({
      category: "amber",
      reasonCode: "moderate_risk",
    });
  });
  it("row 8: Low risk with clean checks -> green meets_checks", () => {
    expect(classifyOperational(complete({}))).toEqual({
      category: "green",
      reasonCode: "meets_checks",
    });
  });
  it("row 9: null flags in a complete row -> grey unmapped", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: null }))).toEqual({
      category: "grey",
      reasonCode: "unmapped",
    });
    expect(classifyOperational(complete({ materialDamageEstablished: null }))).toEqual({
      category: "grey",
      reasonCode: "unmapped",
    });
    expect(classifyOperational(complete({ sufficientEvidence: null }))).toEqual({
      category: "grey",
      reasonCode: "unmapped",
    });
    expect(classifyOperational(complete({ conclusion: null }))).toEqual({
      category: "grey",
      reasonCode: "unmapped",
    });
  });
});

describe("classifyOperational: ordering and properties", () => {
  it("first matching row wins: High risk beats insufficient evidence (3 before 5), damage beats Does not meet (4 before 6)", () => {
    expect(
      classifyOperational(complete({ bankruptcyRisk: "High", sufficientEvidence: false }))
        .reasonCode,
    ).toBe("bankruptcy_high");
    expect(
      classifyOperational(complete({ materialDamageEstablished: true, conclusion: FAILS }))
        .reasonCode,
    ).toBe("material_damage");
  });
  it("Amber is never Green: Moderate never maps to green", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Moderate" })).category).not.toBe(
      "green",
    );
  });
  it("a Moderate risk with a Does not meet conclusion is red, never amber", () => {
    expect(
      classifyOperational(complete({ bankruptcyRisk: "Moderate", conclusion: FAILS })).category,
    ).toBe("red");
  });
  it("the wording of the conclusion alone never makes a candidate green", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Unclear" })).category).toBe("grey");
    expect(classifyOperational(complete({ materialDamageEstablished: null })).category).toBe(
      "grey",
    );
  });
  it("only green and amber can be cleared; pending, grey and red are withheld", () => {
    const cleared = new Set(["green", "amber"]);
    expect(cleared.has(classifyOperational(null).category)).toBe(false);
    expect(cleared.has(classifyOperational(complete({})).category)).toBe(true);
  });
});
