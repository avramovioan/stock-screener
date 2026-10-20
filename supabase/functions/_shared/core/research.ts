// supabase/functions/_shared/core/research.ts
// Pure research-pipeline logic (spec section 9). No Date, URL, console, fetch or randomness (core purity guard).

/** Bump whenever the preamble, the Stage 1 prompt, the schema or the query templates change (spec 9.12). */
export const PROMPT_VERSION = "2026-10-15.1";
export const SCHEMA_VERSION = "research-output-1";

export const ANNUAL_FORMS: readonly string[] = ["10-K", "20-F", "40-F"];
export const INTERIM_FORMS: readonly string[] = ["10-Q"];
export const CURRENT_FORMS: readonly string[] = ["8-K", "6-K"];
/** Forms whose appearance counts as new information for the material-change monitor (spec 9.7). */
export const WATCH_FORMS: readonly string[] = [
  "8-K",
  "6-K",
  "10-Q",
  "10-K",
  "20-F",
  "40-F",
  "NT 10-K",
  "NT 10-Q",
];
export const MAX_QUOTE_CHARS = 300;
export const REPORT_WORDS_MIN = 350;
export const REPORT_WORDS_MAX = 1100;
export const STAGE2_EVIDENCE_MAX_CHARS = 48_000;

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** Stage 1 system prompt (spec 9.6, fixed prefix). */
export const STAGE1_SYSTEM = `
You extract facts from ONE document for an investment research file. You have no other knowledge and no web access.
Return JSON matching the schema. For every fact give: topic (decline_reason, liquidity, debt_maturity, refinancing, covenant,
dilution, going_concern, auditor, regulatory_capital, asset_quality, guidance, litigation, ratings, other), claim (one sentence),
claim_type (established_fact | management_claim | forecast | allegation | interpretation), quote (a VERBATIM substring of the
document, at most 300 characters), and where (section or page if visible). Do not paraphrase inside quote. Do not infer facts that
are not stated. If the document contains nothing relevant, return an empty facts array.
`.trim();

/** Evidence preamble, Stage 2 system role (spec 9.6). */
export const EVIDENCE_PREAMBLE = `
You are the writing stage of a research pipeline. All web research and document reading has ALREADY been done by software; you
have no web access. Every fact you use MUST come from the EVIDENCE items below and MUST be cited by its id like [E3]. Where the
instructions below say "use current web research" or "read the latest report", treat the EVIDENCE items as the result of that work;
if a document the instructions ask for is not present, say so in missing_documents and treat the evidence as incomplete. Never
invent URLs, figures, documents or quotations. Separate established facts, management claims, forecasts, allegations and your own
interpretation in facts_vs_claims. Bankruptcy risk is a qualitative judgement. Do not discuss technical analysis or price charts.
Return JSON that matches the supplied schema. report_md must be about 500-800 words, written for a beginner.
`.trim();

/** Core research prompt of brief section 10, unchanged except for the five placeholders (spec 9.6). */
export const RESEARCH_PROMPT_TEMPLATE = `
Analyze this company for a potential long-term investment.

**COMPANY:** {{COMPANY_NAME}}

**TICKER:** {{TICKER}}

**PRIMARY EXCHANGE:** {{PRIMARY_EXCHANGE}}

**REPORTING CURRENCY:** {{REPORTING_CURRENCY}}

**RESEARCH DATE:** {{RESEARCH_DATE}}

My strategy identifies stocks whose prices have fallen substantially below their historical trend. I assess the technical entry separately. Your job is to investigate the business objectively and answer two questions:

1. Is the stock falling for temporary reasons, or because of lasting damage to the business?
2. Is the company at risk of bankruptcy, or financially strong enough to survive its current problems?

Use current web research. Read the latest available annual report and quarterly or interim report, including relevant financial-statement notes. Check subsequent earnings releases, material announcements, and reliable reporting about the reasons for the decline. Prioritize regulatory filings, the company's investor-relations materials, and credible independent reporting. Treat management's expectations as claims to evaluate.

Use measures appropriate to the industry. For banks and insurers, for example, examine regulatory capital, liquidity, asset quality, and relevant industry disclosures rather than applying ordinary corporate debt ratios mechanically. Explain whether financial distress could seriously damage existing shareholders even if the company avoids bankruptcy.

Assess bankruptcy risk as Low, Moderate, High, or Unclear. This is a qualitative judgment, not a calculated probability. Explain the evidence and limitations.

**OUTPUT FORMAT**

Write for a beginner. Explain unfamiliar terms briefly. Keep the main report to approximately 500–800 words, with sources listed separately.

Finish with one classification:

- Meets these two fundamental checks.
- Does not meet one or both checks.
- Insufficient evidence to decide.

Explain that classification in two or three simple sentences.

Keep technical-analysis commentary outside this report.
`.trim();

/** Stage 2 output JSON schema (spec 9.6.1), verbatim. */
export const RESEARCH_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "report_md",
    "summary",
    "news_reason",
    "conclusion",
    "bankruptcy_risk",
    "material_damage_established",
    "sufficient_evidence",
    "cited_evidence_ids",
    "facts_vs_claims",
    "missing_documents",
    "limitations",
    "research_cutoff_date",
  ],
  properties: {
    report_md: { type: "string" },
    summary: { type: "string" },
    news_reason: { type: "string" },
    conclusion: {
      type: "string",
      enum: [
        "Meets these two fundamental checks.",
        "Does not meet one or both checks.",
        "Insufficient evidence to decide.",
      ],
    },
    bankruptcy_risk: { type: "string", enum: ["Low", "Moderate", "High", "Unclear"] },
    material_damage_established: { type: "boolean" },
    sufficient_evidence: { type: "boolean" },
    cited_evidence_ids: { type: "array", items: { type: "integer" } },
    facts_vs_claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "items"],
        properties: {
          section: {
            type: "string",
            enum: [
              "established_facts",
              "management_claims",
              "forecasts",
              "allegations",
              "interpretation",
            ],
          },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "evidence_ids"],
              properties: {
                text: { type: "string" },
                evidence_ids: { type: "array", items: { type: "integer" } },
              },
            },
          },
        },
      },
    },
    missing_documents: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
    research_cutoff_date: { type: "string" },
  },
};

export const FACT_TOPICS = [
  "decline_reason",
  "liquidity",
  "debt_maturity",
  "refinancing",
  "covenant",
  "dilution",
  "going_concern",
  "auditor",
  "regulatory_capital",
  "asset_quality",
  "guidance",
  "litigation",
  "ratings",
  "other",
] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

export const CLAIM_TYPES = [
  "established_fact",
  "management_claim",
  "forecast",
  "allegation",
  "interpretation",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Stage 1 output schema: one object with a `facts` array (spec 9.6). */
export const STAGE1_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "claim", "claim_type", "quote", "where"],
        properties: {
          topic: { type: "string", enum: [...FACT_TOPICS] },
          claim: { type: "string" },
          claim_type: { type: "string", enum: [...CLAIM_TYPES] },
          quote: { type: "string" },
          where: { type: "string" },
        },
      },
    },
  },
};

export type SourceKind =
  | "edgar_filing"
  | "ir_page"
  | "rss"
  | "yahoo_news"
  | "search_result"
  | "other";
export type ResearchConclusion =
  | "Meets these two fundamental checks."
  | "Does not meet one or both checks."
  | "Insufficient evidence to decide.";
export type ResearchBankruptcyRisk = "Low" | "Moderate" | "High" | "Unclear";
export type ClaimSection =
  | "established_facts"
  | "management_claims"
  | "forecasts"
  | "allegations"
  | "interpretation";

export interface Stage1Fact {
  topic: FactTopic;
  claim: string;
  claim_type: ClaimType;
  quote: string;
  where: string;
}

export interface LedgerEntry {
  evidenceId: number;
  url: string;
  title: string | null;
  publisher: string | null;
  kind: SourceKind;
  publishedAt: string | null;
  filingDate: string | null;
  retrievedAt: string | null;
  verification: "pending" | "ok" | "failed" | "skipped";
  facts: Stage1Fact[];
}

export interface PromptVars {
  companyName: string;
  ticker: string;
  primaryExchange: string;
  reportingCurrency: string;
  researchDate: string;
}

export interface ResearchOutput {
  report_md: string;
  summary: string;
  news_reason: string;
  conclusion: ResearchConclusion;
  bankruptcy_risk: ResearchBankruptcyRisk;
  material_damage_established: boolean;
  sufficient_evidence: boolean;
  cited_evidence_ids: number[];
  facts_vs_claims: { section: ClaimSection; items: { text: string; evidence_ids: number[] }[] }[];
  missing_documents: string[];
  limitations: string[];
  research_cutoff_date: string;
}

// ---------------------------------------------------------------- prompts

/** Fills the five placeholders in a single pass (values are never re-scanned and `$` patterns are inert). */
export function fillResearchPrompt(vars: PromptVars): string {
  const values: Record<string, string> = {
    "{{COMPANY_NAME}}": vars.companyName,
    "{{TICKER}}": vars.ticker,
    "{{PRIMARY_EXCHANGE}}": vars.primaryExchange,
    "{{REPORTING_CURRENCY}}": vars.reportingCurrency,
    "{{RESEARCH_DATE}}": vars.researchDate,
  };
  return RESEARCH_PROMPT_TEMPLATE.replace(/\{\{[A-Z_]+\}\}/g, (token) => {
    const value = values[token]?.trim();
    if (value === undefined) throw new Error(`unknown placeholder ${token}`);
    if (value === "") throw new Error(`research prompt variable for ${token} is empty`);
    return value;
  });
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/"/g, "'").trim();

export function dateLabel(e: Pick<LedgerEntry, "kind" | "publishedAt" | "filingDate">): string {
  if (e.filingDate) return `filing date ${e.filingDate.slice(0, 10)}`;
  if (e.publishedAt) {
    const day = e.publishedAt.slice(0, 10);
    return e.kind === "search_result" ? `date as reported by search ${day}` : `published ${day}`;
  }
  return "date not available";
}

export interface Stage1Doc {
  evidenceId: number;
  title: string | null;
  kind: SourceKind;
  dateLabel: string;
  url: string;
  text: string;
}

export function buildStage1User(doc: Stage1Doc): string {
  return [
    "DOCUMENT METADATA",
    `evidence_id: E${doc.evidenceId}`,
    `title: ${oneLine(doc.title ?? doc.url)}`,
    `kind: ${doc.kind}`,
    `date: ${doc.dateLabel}`,
    `url: ${doc.url}`,
    "DOCUMENT TEXT:",
    doc.text,
  ].join("\n");
}

export function renderEvidenceEntry(e: LedgerEntry): string {
  const head = `[E${e.evidenceId}] kind=${e.kind} title="${oneLine(e.title ?? e.url)}" date=${dateLabel(e)} retrieved=${e.retrievedAt ?? "not retrieved"}`;
  const lines = e.facts.map(
    (f) => `- (${f.claim_type}) ${oneLine(f.claim)}  | quote: "${oneLine(f.quote)}"`,
  );
  if (lines.length === 0) return `${head}\n     facts: (no facts extracted; headline only)`;
  return [head, `     facts: ${lines[0]}`, ...lines.slice(1).map((l) => `            ${l}`)].join(
    "\n",
  );
}

/** Keeps the evidence block inside the character budget; entries that do not fit are reported as omitted. */
export function fitEvidence(
  entries: readonly LedgerEntry[],
  maxChars = STAGE2_EVIDENCE_MAX_CHARS,
): { shown: LedgerEntry[]; omitted: number[] } {
  const shown: LedgerEntry[] = [];
  const omitted: number[] = [];
  let used = 0;
  for (const entry of entries) {
    const min = entry.facts.length === 0 ? 0 : 1;
    let placed = false;
    for (let keep = entry.facts.length; keep >= min; keep--) {
      const candidate =
        keep === entry.facts.length ? entry : { ...entry, facts: entry.facts.slice(0, keep) };
      const size = renderEvidenceEntry(candidate).length + 1;
      if (used + size <= maxChars) {
        shown.push(candidate);
        used += size;
        placed = true;
        break;
      }
    }
    if (!placed) omitted.push(entry.evidenceId);
  }
  return { shown, omitted };
}

export interface Stage2Context {
  vars: PromptVars;
  industryNote: string;
  deterministicData: string;
  shown: readonly LedgerEntry[];
  missing: readonly string[];
  feedback?: string | undefined;
}

/** Stage 2 user message exactly as spec 9.6: core prompt, cutoff, industry, deterministic data, ledger, missing. */
export function buildStage2User(ctx: Stage2Context): string {
  const data = ctx.deterministicData.trim();
  const lines = [
    fillResearchPrompt(ctx.vars),
    "",
    `RESEARCH CUTOFF DATE: ${ctx.vars.researchDate}  (state this date in research_cutoff_date)`,
    `INDUSTRY GUIDANCE: ${ctx.industryNote}`,
    `DETERMINISTIC DATA (from EDGAR, may be empty): ${data === "" ? "none" : data}`,
    "EVIDENCE:",
    ...(ctx.shown.length === 0
      ? ["(no evidence items were obtained)"]
      : ctx.shown.map(renderEvidenceEntry)),
    `MISSING OR FAILED RETRIEVALS: ${ctx.missing.length === 0 ? "none" : ctx.missing.join("; ")}`,
  ];
  if (ctx.feedback && ctx.feedback.trim() !== "")
    lines.push("", `CORRECTION REQUIRED: ${ctx.feedback.trim()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- retrieval planning

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function dateTerms(researchDate: string): {
  year: number;
  month: string;
  fiscalYear: number;
  quarter: string;
} {
  const year = Number(researchDate.slice(0, 4));
  const monthIndex = Number(researchDate.slice(5, 7));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(researchDate) || monthIndex < 1 || monthIndex > 12) {
    throw new Error(`invalid research date ${researchDate}`);
  }
  const currentQuarter = Math.ceil(monthIndex / 3);
  const quarter = currentQuarter === 1 ? `Q4 ${year - 1}` : `Q${currentQuarter - 1} ${year}`;
  return { year, month: MONTHS[monthIndex - 1] ?? "", fiscalYear: year - 1, quarter };
}

export type IndustryKind = "financial" | "general";

export function industryKind(
  sector: string | null | undefined,
  industry?: string | null,
): IndustryKind {
  return /financial|bank|insur/i.test(`${sector ?? ""} ${industry ?? ""}`)
    ? "financial"
    : "general";
}

export function industryNote(kind: IndustryKind): string {
  return kind === "financial"
    ? "bank/insurer: use regulatory capital, liquidity, asset quality"
    : "operating company: use liquidity, debt maturities, refinancing needs, covenants and cash generation";
}

export interface QueryContext {
  company: string;
  ticker: string;
  researchDate: string;
  industry: IndustryKind;
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The six deterministic query templates of spec 9.3. */
export function queryTemplates(ctx: QueryContext): string[] {
  const t = dateTerms(ctx.researchDate);
  const terms = ctx.industry === "financial" ? "regulatory capital liquidity asset quality" : "";
  return [
    `${ctx.company} ${ctx.ticker} annual report ${t.fiscalYear} investor relations`,
    `${ctx.company} latest quarterly interim results ${t.quarter}`,
    `${ctx.company} shares fall reason ${t.month} ${t.year}`,
    `${ctx.company} debt maturities refinancing covenants liquidity ${terms}`,
    `${ctx.company} going concern OR credit rating downgrade OR investigation OR restatement`,
    ctx.industry === "financial"
      ? `${ctx.company} ${terms} regulatory disclosure`
      : `${ctx.company} guidance outlook management commentary`,
  ].map(clean);
}

export interface RankCandidate {
  evidenceId: number;
  url: string;
  kind: SourceKind;
  form?: string | null | undefined;
  publishedAt?: string | null | undefined;
  filingDate?: string | null | undefined;
}

export function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return (match?.[1] ?? "").toLowerCase();
}

const REGULATOR_HOST =
  /(^|\.)(sec\.gov|fca\.org\.uk|esma\.europa\.eu|ecb\.europa\.eu|eba\.europa\.eu|eiopa\.europa\.eu|bafin\.de|fdic\.gov|federalreserve\.gov|occ\.gov|edinet-fsa\.go\.jp)$|\.gov$|\.gov\.[a-z]{2}$/;

export function isRegulatorHost(host: string): boolean {
  return REGULATOR_HOST.test(host.toLowerCase());
}

export function isIrUrl(url: string): boolean {
  const host = hostOf(url);
  if (/^(investor|investors|ir)\./.test(host)) return true;
  return /\/(investors?|ir)(\/|$)/i.test(url.replace(/^[a-z]+:\/\/[^/]+/i, ""));
}

const inForms = (forms: readonly string[], form: string | null | undefined): boolean =>
  forms.includes((form ?? "").toUpperCase());

/** 0 EDGAR annual, 1 EDGAR interim, 2 EDGAR current, 3 company IR, 4 regulators, 5 independent (spec 9.3). */
export function documentTier(c: RankCandidate): number {
  if (c.kind === "edgar_filing") {
    if (inForms(ANNUAL_FORMS, c.form)) return 0;
    if (inForms(INTERIM_FORMS, c.form)) return 1;
    if (inForms(CURRENT_FORMS, c.form)) return 2;
    return 5;
  }
  if (c.kind === "ir_page" || c.kind === "rss" || isIrUrl(c.url)) return 3;
  if (isRegulatorHost(hostOf(c.url))) return 4;
  return 5;
}

const dayOf = (c: RankCandidate): string => (c.filingDate ?? c.publishedAt ?? "").slice(0, 10);

export function rankDocuments<T extends RankCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    const ta = documentTier(a);
    const tb = documentTier(b);
    if (ta !== tb) return ta - tb;
    const da = dayOf(a);
    const db = dayOf(b);
    if (da !== db) return da > db ? -1 : 1;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : a.evidenceId - b.evidenceId;
  });
}

/** At most `max` documents (default 8), of which at most `edgarMax` (default 3) are EDGAR filings. */
export function selectDocuments<T extends RankCandidate>(
  ranked: readonly T[],
  opts: { max?: number; edgarMax?: number } = {},
): T[] {
  const max = opts.max ?? 8;
  const edgarMax = opts.edgarMax ?? 3;
  const picked: T[] = [];
  let edgar = 0;
  for (const c of ranked) {
    if (picked.length >= max) break;
    if (c.kind === "edgar_filing") {
      if (edgar >= edgarMax) continue;
      edgar++;
    }
    picked.push(c);
  }
  return picked;
}

export interface FilingLike {
  form: string;
  accession: string;
  filingDate: string;
  primaryDocument: string;
}

const byFilingDateDesc = (a: FilingLike, b: FilingLike): number =>
  a.filingDate !== b.filingDate
    ? a.filingDate > b.filingDate
      ? -1
      : 1
    : a.accession < b.accession
      ? 1
      : -1;

/** Latest annual, latest interim and up to 3 current reports filed after the annual (spec 9.3, 9.10 prefetch). */
export function pickFilings<T extends FilingLike>(
  filings: readonly T[],
): { annual: T | null; interim: T | null; current: T[] } {
  const sorted = [...filings].sort(byFilingDateDesc);
  const annual = sorted.find((f) => inForms(ANNUAL_FORMS, f.form)) ?? null;
  const interim = sorted.find((f) => inForms(INTERIM_FORMS, f.form)) ?? null;
  const since = annual?.filingDate ?? "";
  const current = sorted
    .filter((f) => inForms(CURRENT_FORMS, f.form) && f.filingDate > since)
    .slice(0, 3);
  return { annual, interim, current };
}

export function renderFilingList(filings: readonly FilingLike[], limit = 12): string {
  return [...filings]
    .sort(byFilingDateDesc)
    .slice(0, limit)
    .map((f) => `- ${f.form} filed ${f.filingDate} (accession ${f.accession})`)
    .join("\n");
}

// ---------------------------------------------------------------- validation

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A quote is valid when it is <= 300 characters and occurs in the text after whitespace normalisation. */
export function quoteOccurs(quote: string, text: string): boolean {
  const q = normalizeWs(quote);
  if (q === "" || q.length > MAX_QUOTE_CHARS) return false;
  return normalizeWs(text).includes(q);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export interface Stage1Validation {
  valid: boolean;
  kept: Stage1Fact[];
  dropped: number;
}

/** Keeps only facts with a verbatim quote; an unknown topic becomes `other`, an unknown claim type drops the fact. */
export function validateStage1Facts(raw: unknown, docText: string): Stage1Validation {
  if (!isObj(raw) || !Array.isArray(raw.facts)) return { valid: false, kept: [], dropped: 0 };
  const normalized = normalizeWs(docText);
  const kept: Stage1Fact[] = [];
  let dropped = 0;
  for (const item of raw.facts) {
    if (!isObj(item)) {
      dropped++;
      continue;
    }
    const claim = typeof item.claim === "string" ? item.claim.trim() : "";
    const quote = typeof item.quote === "string" ? normalizeWs(item.quote) : "";
    if (claim === "" || !oneOf(CLAIM_TYPES, item.claim_type)) {
      dropped++;
      continue;
    }
    if (quote === "" || quote.length > MAX_QUOTE_CHARS || !normalized.includes(quote)) {
      dropped++;
      continue;
    }
    kept.push({
      topic: oneOf(FACT_TOPICS, item.topic) ? item.topic : "other",
      claim,
      claim_type: item.claim_type,
      quote,
      where: typeof item.where === "string" ? item.where.trim() : "",
    });
  }
  return { valid: true, kept, dropped };
}

export function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** URLs typed by the model are discarded; our code renders URLs from the ledger (spec 9.5 rule 1). */
export function stripUrls(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s)\]>"'<]+/gi, "[link removed]")
    .replace(/\bwww\.[^\s)\]>"'<]+/gi, "[link removed]");
}

const CONCLUSIONS = [
  "Meets these two fundamental checks.",
  "Does not meet one or both checks.",
  "Insufficient evidence to decide.",
] as const;
const RISKS = ["Low", "Moderate", "High", "Unclear"] as const;
const SECTIONS = [
  "established_facts",
  "management_claims",
  "forecasts",
  "allegations",
  "interpretation",
] as const;
const OUTPUT_KEYS = [
  "report_md",
  "summary",
  "news_reason",
  "conclusion",
  "bankruptcy_risk",
  "material_damage_established",
  "sufficient_evidence",
  "cited_evidence_ids",
  "facts_vs_claims",
  "missing_documents",
  "limitations",
  "research_cutoff_date",
];

const isIdList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0);
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

function checkShape(raw: unknown): string[] {
  if (!isObj(raw)) return ["the output is not a JSON object"];
  const errs: string[] = [];
  for (const key of ["report_md", "summary", "news_reason"]) {
    if (typeof raw[key] !== "string") errs.push(`${key} must be a string`);
  }
  if (!oneOf(CONCLUSIONS, raw.conclusion))
    errs.push("conclusion must be one of the three exact strings");
  if (!oneOf(RISKS, raw.bankruptcy_risk))
    errs.push("bankruptcy_risk must be Low, Moderate, High or Unclear");
  for (const key of ["material_damage_established", "sufficient_evidence"]) {
    if (typeof raw[key] !== "boolean") errs.push(`${key} must be a boolean`);
  }
  if (!isIdList(raw.cited_evidence_ids))
    errs.push("cited_evidence_ids must be an array of positive integers");
  if (!Array.isArray(raw.facts_vs_claims)) {
    errs.push("facts_vs_claims must be an array");
  } else {
    for (const group of raw.facts_vs_claims) {
      if (!isObj(group) || !oneOf(SECTIONS, group.section) || !Array.isArray(group.items)) {
        errs.push("each facts_vs_claims entry needs a valid section and an items array");
        continue;
      }
      for (const item of group.items) {
        if (!isObj(item) || typeof item.text !== "string" || !isIdList(item.evidence_ids)) {
          errs.push("each facts_vs_claims item needs text and evidence_ids");
        }
      }
    }
  }
  if (!isStringList(raw.missing_documents))
    errs.push("missing_documents must be an array of strings");
  if (!isStringList(raw.limitations)) errs.push("limitations must be an array of strings");
  if (
    typeof raw.research_cutoff_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.research_cutoff_date)
  ) {
    errs.push("research_cutoff_date must be YYYY-MM-DD");
  }
  for (const key of Object.keys(raw)) {
    if (!OUTPUT_KEYS.includes(key)) errs.push(`unexpected property ${key}`);
  }
  return errs;
}

export interface ValidationResult {
  ok: boolean;
  /** The sanitised output (URLs stripped, ids sorted, uncited established facts dropped) when `ok`. */
  output: ResearchOutput | null;
  /** Feedback for the one allowed retry (attempt 1 only). */
  retryWith?: string;
  /** Terminal failure code when `ok` is false and no retry is left. */
  failure?: "invalid_json" | "unknown_evidence_id";
  /** Limitation codes added by the validator (the handler merges them with the model's own). */
  limitations: string[];
  inconsistent: boolean;
}

const fail = (extra: Pick<ValidationResult, "retryWith" | "failure">): ValidationResult => ({
  ok: false,
  output: null,
  limitations: [],
  inconsistent: false,
  ...extra,
});

/**
 * The code-check table of spec 9.6.1. Attempt 1 collects every retryable problem into one feedback message;
 * attempt 2 degrades instead: drop uncited established facts, store with a length limitation, store an
 * inconsistent "Meets" with `inconsistent_output`. Unknown evidence ids and schema failures stay terminal.
 */
export function validateResearchOutput(
  raw: unknown,
  ledgerIds: readonly number[],
  attempt: 1 | 2 = 1,
): ValidationResult {
  const shapeErrors = checkShape(raw);
  if (shapeErrors.length > 0) {
    return attempt === 1
      ? fail({
          retryWith: `Your reply did not match the JSON schema: ${shapeErrors.slice(0, 5).join("; ")}. Return only JSON that matches the schema.`,
        })
      : fail({ failure: "invalid_json" });
  }
  const out = JSON.parse(JSON.stringify(raw)) as ResearchOutput;
  const allowed = new Set(ledgerIds);
  const used = new Set<number>(out.cited_evidence_ids);
  for (const group of out.facts_vs_claims) {
    for (const item of group.items) for (const id of item.evidence_ids) used.add(id);
  }
  for (const m of out.report_md.matchAll(/\[E(\d+)\]/g)) used.add(Number(m[1]));
  const unknown = [...used].filter((id) => !allowed.has(id)).sort((a, b) => a - b);
  const feedback: string[] = [];
  if (unknown.length > 0) {
    if (attempt === 2) return fail({ failure: "unknown_evidence_id" });
    const known = [...allowed]
      .sort((a, b) => a - b)
      .map((id) => `E${id}`)
      .join(", ");
    feedback.push(
      `These evidence ids are not in the ledger: ${unknown.map((id) => `E${id}`).join(", ")}. Cite only ${known || "nothing (the ledger is empty)"}.`,
    );
  }
  const uncited = out.facts_vs_claims
    .filter((g) => g.section === "established_facts")
    .reduce((n, g) => n + g.items.filter((i) => i.evidence_ids.length === 0).length, 0);
  if (uncited > 0) {
    feedback.push(
      "Every item under established_facts needs at least one evidence id; add one or move the item to interpretation.",
    );
  }
  const wc = wordCount(out.report_md);
  const badLength = wc < REPORT_WORDS_MIN || wc > REPORT_WORDS_MAX;
  if (badLength) {
    feedback.push(
      `report_md has ${wc} words; write about 500-800 words (never fewer than ${REPORT_WORDS_MIN} or more than ${REPORT_WORDS_MAX}).`,
    );
  }
  const establishedCount = out.facts_vs_claims
    .filter((g) => g.section === "established_facts")
    .reduce((n, g) => n + g.items.length, 0);
  const inconsistent =
    out.conclusion === "Meets these two fundamental checks." &&
    (!(
      out.sufficient_evidence &&
      !out.material_damage_established &&
      (out.bankruptcy_risk === "Low" || out.bankruptcy_risk === "Moderate")
    ) ||
      (out.cited_evidence_ids.length === 0 && establishedCount === 0));
  if (inconsistent) {
    feedback.push(
      'Reconcile the output: "Meets these two fundamental checks." requires sufficient_evidence=true, material_damage_established=false and bankruptcy_risk Low or Moderate; otherwise choose another conclusion. A "Meets" conclusion also needs at least one cited evidence id or established fact.',
    );
  }
  if (attempt === 1 && feedback.length > 0) return fail({ retryWith: feedback.join(" ") });

  const limitations: string[] = [];
  let dropped = 0;
  const groups = out.facts_vs_claims.map((g) =>
    g.section !== "established_facts"
      ? g
      : {
          ...g,
          items: g.items.filter((i) => {
            if (i.evidence_ids.length > 0) return true;
            dropped++;
            return false;
          }),
        },
  );
  if (dropped > 0) limitations.push(`dropped_uncited_established_facts:${dropped}`);
  if (badLength) limitations.push(`report_length_out_of_range:${wc}`);
  if (inconsistent) limitations.push("inconsistent_output");
  const uniqueSorted = (ids: number[]): number[] => [...new Set(ids)].sort((a, b) => a - b);
  const output: ResearchOutput = {
    ...out,
    report_md: stripUrls(out.report_md),
    summary: stripUrls(out.summary),
    news_reason: stripUrls(out.news_reason),
    cited_evidence_ids: uniqueSorted([...used]),
    facts_vs_claims: groups.map((g) => ({
      section: g.section,
      items: g.items.map((i) => ({
        text: stripUrls(i.text),
        evidence_ids: uniqueSorted(i.evidence_ids),
      })),
    })),
    missing_documents: out.missing_documents.map(stripUrls),
    limitations: out.limitations.map(stripUrls),
  };
  return { ok: true, output, limitations, inconsistent };
}

// ---------------------------------------------------------------- rendering

const mdText = (s: string): string =>
  s.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
const mdUrl = (u: string): string =>
  u.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

/** The "Sources" section, rendered only from ledger rows, in evidence order (spec 9.5 rule 1 and 5). */
export function renderSources(entries: readonly LedgerEntry[]): string {
  if (entries.length === 0) return "## Sources\n\nNo sources were cited.";
  const lines = [...entries]
    .sort((a, b) => a.evidenceId - b.evidenceId)
    .map(
      (e) =>
        `- [E${e.evidenceId}] [${mdText(e.title ?? e.url)}](${mdUrl(e.url)}) - ${e.publisher ?? "publisher not available"} - ${dateLabel(e)}`,
    );
  return ["## Sources", "", ...lines].join("\n");
}
