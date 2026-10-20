import { words } from "./words.ts";

export { words };

/** Stage 1: one fact whose quote is copied from the start of the document text in the prompt, so it always verifies. */
export function stage1Answer(user: string) {
  const body = user.split("DOCUMENT TEXT:\n")[1] ?? "";
  const quote = body.slice(0, 80).replace(/\s+/g, " ").trim();
  return {
    facts: [
      {
        topic: "liquidity",
        claim: "The company describes its liquidity.",
        claim_type: "management_claim",
        quote,
        where: "MD&A",
      },
    ],
  };
}

/** Ids of the ledger entries of a Stage 2 prompt, those with extracted facts first. */
function ledgerIds(user: string): number[] {
  const blocks = user.split(/\n(?=\[E\d+\] kind=)/).filter((b) => /^\[E\d+\] kind=/.test(b));
  const entries = blocks.map((b) => ({
    id: Number(/^\[E(\d+)\]/.exec(b)?.[1]),
    facts: !b.includes("(no facts extracted"),
  }));
  return [...entries.filter((e) => e.facts), ...entries.filter((e) => !e.facts)].map((e) => e.id);
}

/** Stage 2: cites the first two ledger entries; the verdict is chosen by the ticker in the prompt (RDCO is the distressed one). */
export function stage2Answer(user: string) {
  const ids = ledgerIds(user).slice(0, 2);
  const red = /\*\*TICKER:\*\* RDCO/.test(user);
  return {
    report_md: `${words(520)} [E${ids[0] ?? 1}]`,
    summary: red
      ? "Distress after a covenant breach; withheld."
      : "Fell on a one-time customer loss; balance sheet is sound.",
    news_reason: red ? "Covenant breach and going-concern doubt." : "One-time customer loss.",
    conclusion: red ? "Does not meet one or both checks." : "Meets these two fundamental checks.",
    bankruptcy_risk: red ? "High" : "Low",
    material_damage_established: red,
    sufficient_evidence: true,
    cited_evidence_ids: ids,
    facts_vs_claims: [
      {
        section: "established_facts",
        items: [{ text: "Liquidity is described in the filing.", evidence_ids: ids.slice(0, 1) }],
      },
    ],
    missing_documents: [],
    limitations: [],
    research_cutoff_date:
      /RESEARCH CUTOFF DATE: (\d{4}-\d{2}-\d{2})/.exec(user)?.[1] ?? "2026-10-15",
  };
}

/** Change check: always a material liquidity/debt change that cites the first numbered item. */
export function changeAnswer() {
  return {
    material: true,
    category: "liquidity_debt",
    severity: "material",
    summary: "The 8-K discloses a covenant waiver request.",
    evidence_ids: [1],
  };
}
