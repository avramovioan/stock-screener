export type ResearchStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "quota_deferred"
  | "stale";
export type Category = "green" | "amber" | "red" | "grey" | "pending";
export type Conclusion =
  | "Meets these two fundamental checks."
  | "Does not meet one or both checks."
  | "Insufficient evidence to decide.";
export type BankruptcyRisk = "Low" | "Moderate" | "High" | "Unclear";

export interface ResearchFacts {
  status: ResearchStatus;
  conclusion: Conclusion | null;
  bankruptcyRisk: BankruptcyRisk | null;
  materialDamageEstablished: boolean | null;
  sufficientEvidence: boolean | null;
}

/**
 * Operational classification (4.8). First matching row wins; the category never derives from the wording of the conclusion alone.
 */
export function classifyOperational(r: ResearchFacts | null): {
  category: Category;
  reasonCode: string;
} {
  // 1. no report, or no completed result yet
  if (
    r === null ||
    r.status === "queued" ||
    r.status === "running" ||
    r.status === "quota_deferred" ||
    r.status === "stale"
  ) {
    return {
      category: "pending",
      reasonCode:
        r !== null && r.status === "quota_deferred"
          ? "research_quota_deferred"
          : "research_pending",
    };
  }
  // 2. terminal failure after retries
  if (r.status === "failed") return { category: "grey", reasonCode: "research_failed" };
  // from here status = complete
  if (r.bankruptcyRisk === "High") return { category: "red", reasonCode: "bankruptcy_high" }; // 3
  if (r.materialDamageEstablished === true)
    return { category: "red", reasonCode: "material_damage" }; // 4
  if (
    r.bankruptcyRisk === "Unclear" ||
    r.sufficientEvidence === false ||
    r.conclusion === "Insufficient evidence to decide."
  ) {
    return { category: "grey", reasonCode: "inconclusive" }; // 5
  }
  if (r.conclusion === "Does not meet one or both checks.")
    return { category: "red", reasonCode: "does_not_meet" }; // 6
  const cleanChecks =
    r.sufficientEvidence === true &&
    r.materialDamageEstablished === false &&
    r.conclusion === "Meets these two fundamental checks.";
  if (r.bankruptcyRisk === "Moderate" && cleanChecks)
    return { category: "amber", reasonCode: "moderate_risk" }; // 7
  if (r.bankruptcyRisk === "Low" && cleanChecks)
    return { category: "green", reasonCode: "meets_checks" }; // 8
  return { category: "grey", reasonCode: "unmapped" }; // 9: null flags in a "complete" row, unexpected combinations
}
