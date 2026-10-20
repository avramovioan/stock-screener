// supabase/functions/_shared/core/risk.ts
// Pure logic of the material-change monitor (spec 9.7). No Date, URL, console, fetch or randomness.
import { type JsonSchemaObject, WATCH_FORMS } from "./research.ts";

/** Yahoo news keyword pre-filter (A-29), strongest first. */
export const NEWS_KEYWORDS = [
  "going concern",
  "bankruptcy",
  "default",
  "covenant",
  "downgrade",
  "restatement",
  "investigation",
  "probe",
  "lawsuit",
  "fraud",
  "guidance",
  "profit warning",
  "recall",
  "delisting",
  "capital raise",
] as const;

const PATTERNS = NEWS_KEYWORDS.map((keyword) => ({
  keyword,
  re: new RegExp(`\\b${keyword.replace(/ /g, "\\s+")}`, "i"),
}));

/** Whole-word-start match, so "downgraded", "lawsuits" and "defaulted" count but "problem" is not "probe". */
export function matchKeywords(title: string): string[] {
  return PATTERNS.filter(({ re }) => re.test(title)).map(({ keyword }) => keyword);
}

export function strongestKeyword(keywords: readonly string[]): string | null {
  return NEWS_KEYWORDS.find((k) => keywords.includes(k)) ?? null;
}

export interface ItemLike {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  form?: string | undefined;
}
export interface SeenItems {
  yahoo?: string[];
  edgar?: string[];
  rss?: string[];
}
export interface LatestLike {
  yahoo?: ItemLike[];
  edgar?: ItemLike[];
  rss?: ItemLike[];
}
export interface Delta {
  edgar: ItemLike[];
  rss: ItemLike[];
  yahoo: ItemLike[];
  keywords: string[];
}

/** New items since the last acknowledged check (spec 9.7 step 1). */
export function computeDelta(seen: SeenItems, latest: LatestLike): Delta {
  const seenEdgar = new Set(seen.edgar ?? []);
  const seenRss = new Set(seen.rss ?? []);
  const seenYahoo = new Set(seen.yahoo ?? []);
  const edgar = (latest.edgar ?? []).filter(
    (i) => !seenEdgar.has(i.id) && WATCH_FORMS.includes(i.form ?? ""),
  );
  const rss = (latest.rss ?? []).filter((i) => !seenRss.has(i.id));
  const yahoo = (latest.yahoo ?? []).filter(
    (i) => !seenYahoo.has(i.id) && matchKeywords(i.title).length > 0,
  );
  const keywords = [...new Set([...yahoo, ...rss].flatMap((i) => matchKeywords(i.title)))];
  return { edgar, rss, yahoo, keywords };
}

export const isEmptyDelta = (d: Delta): boolean =>
  d.edgar.length + d.rss.length + d.yahoo.length === 0;

/** Nothing acknowledged yet: the first check records a baseline; the full report covers the history. */
export function isFirstObservation(seen: SeenItems): boolean {
  return (seen.edgar?.length ?? 0) + (seen.rss?.length ?? 0) + (seen.yahoo?.length ?? 0) === 0;
}

/** Acknowledges every latest id, keeping the newest `cap` ids per channel. */
export function mergeSeen(seen: SeenItems, latest: LatestLike, cap = 200): SeenItems {
  const merge = (old: string[] | undefined, items: ItemLike[] | undefined): string[] => {
    const ids = [...(old ?? [])];
    for (const i of items ?? []) if (!ids.includes(i.id)) ids.push(i.id);
    return ids.slice(-cap);
  };
  return {
    edgar: merge(seen.edgar, latest.edgar),
    rss: merge(seen.rss, latest.rss),
    yahoo: merge(seen.yahoo, latest.yahoo),
  };
}

export const CHANGE_CATEGORIES = [
  "liquidity_debt",
  "guidance",
  "accounting_audit",
  "regulatory_legal",
  "credit_rating",
  "governance",
  "other",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

/** Explicit material-change criteria (A-29); the classification call receives this list. */
export const MATERIAL_CRITERIA = [
  "- liquidity_debt: going-concern doubt; covenant breach or waiver request; missed payment or grace period; distressed exchange or restructuring; failed or very costly refinancing; emergency equity raise; debt maturity wall not covered by liquidity.",
  "- credit_rating: downgrade to below investment grade, or a downgrade of two or more notches, or a negative watch from a major agency.",
  "- accounting_audit: restatement or non-reliance on prior statements; auditor resignation or qualified opinion; late annual or quarterly filing (NT forms).",
  "- regulatory_legal: formal investigation, fraud allegation, sanction threatening a licence or capital (banks and insurers: capital shortfall or supervisory action), litigation with potentially balance-sheet-level impact.",
  "- guidance: guidance withdrawal, profit warning or a cut large enough to change the investment thesis.",
  "- governance: abrupt CEO or CFO exit together with another red flag.",
].join("\n");

export const CHANGE_SYSTEM = [
  "You decide whether NEW public items about ONE listed company are a material change for a long-term shareholder.",
  "You have no other knowledge and no web access. Use only the numbered items you are given and cite them by id in evidence_ids.",
  'Set material=true only when an item meets one of the criteria below; otherwise set material=false, category "other" and severity "watch".',
  "summary is one or two plain sentences. Never invent facts, figures or sources.",
  "",
  "MATERIAL CHANGE CRITERIA",
  MATERIAL_CRITERIA,
].join("\n");

export const CHANGE_CLASSIFICATION_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["material", "category", "severity", "summary", "evidence_ids"],
  properties: {
    material: { type: "boolean" },
    category: { type: "string", enum: [...CHANGE_CATEGORIES] },
    severity: { type: "string", enum: ["material", "watch"] },
    summary: { type: "string" },
    evidence_ids: { type: "array", items: { type: "integer" } },
  },
};

export interface ChangeItem {
  id: number;
  kind: "edgar_filing" | "rss" | "yahoo_news" | "search_result";
  title: string;
  date: string | null;
  excerpt: string;
  /** Primary source: an SEC filing or a company investor-relations feed item. */
  primary: boolean;
  url: string;
}

const CHANGE_USER_MAX_CHARS = 16_000; // about 4k tokens

export function buildChangeUser(ctx: {
  company: string;
  ticker: string;
  previous: { category: string | null; summary: string | null; date: string | null } | null;
  items: readonly ChangeItem[];
  /** Character cap of the whole user message; defaults to 16,000 (a provider with a token budget passes less). */
  maxChars?: number | undefined;
}): string {
  const cap = Math.min(ctx.maxChars ?? CHANGE_USER_MAX_CHARS, CHANGE_USER_MAX_CHARS);
  const previous = ctx.previous
    ? `category=${ctx.previous.category ?? "unknown"}; summary=${ctx.previous.summary ?? "none"}; date=${ctx.previous.date ?? "unknown"}`
    : "none";
  const head = [
    `COMPANY: ${ctx.company} (${ctx.ticker})`,
    `PREVIOUS ASSESSMENT: ${previous}`,
    "NEW ITEMS:",
  ];
  const blocks: string[] = [];
  let used = head.join("\n").length + 60;
  let omitted = 0;
  for (const i of ctx.items) {
    const block = `[E${i.id}] kind=${i.kind} date=${i.date ?? "not available"} title="${i.title.replace(/\s+/g, " ").replace(/"/g, "'")}"\n     excerpt: ${i.excerpt.replace(/\s+/g, " ").slice(0, 400)}`;
    if (used + block.length + 1 > cap) {
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  return [
    ...head,
    ...blocks,
    ...(omitted > 0 ? [`(${omitted} further items omitted for length)`] : []),
  ].join("\n");
}

export interface ChangeOutput {
  material: boolean;
  category: ChangeCategory;
  severity: "material" | "watch";
  summary: string;
  evidence_ids: number[];
}

export function validateChangeOutput(
  raw: unknown,
  allowedIds: readonly number[],
): { ok: true; output: ChangeOutput } | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, message: "not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.material !== "boolean") return { ok: false, message: "material must be a boolean" };
  if (!(CHANGE_CATEGORIES as readonly string[]).includes(String(o.category)))
    return { ok: false, message: "unknown category" };
  if (o.severity !== "material" && o.severity !== "watch")
    return { ok: false, message: "unknown severity" };
  if (typeof o.summary !== "string" || o.summary.trim() === "")
    return { ok: false, message: "summary is required" };
  if (!Array.isArray(o.evidence_ids) || !o.evidence_ids.every((n) => Number.isInteger(n))) {
    return { ok: false, message: "evidence_ids must be integers" };
  }
  const ids = o.evidence_ids as number[];
  if (ids.some((id) => !allowedIds.includes(id)))
    return { ok: false, message: "unknown evidence id" };
  if (o.material && ids.length === 0)
    return { ok: false, message: "a material change must cite evidence" };
  return {
    ok: true,
    output: {
      material: o.material,
      category: o.category as ChangeCategory,
      severity: o.severity,
      summary: o.summary.trim().slice(0, 400),
      evidence_ids: ids,
    },
  };
}

/** Input of `sha256(category + sorted canonical primary URLs)` (spec 9.7 step 4). */
export function fingerprintInput(category: string, canonicalUrls: readonly string[]): string {
  return `${category}\n${[...new Set(canonicalUrls)].sort().join("\n")}`;
}

/** An open finding of the same category with no new primary-source evidence is only updated. */
export function findingAction(
  open: { primaryUrls: readonly string[] } | null,
  newPrimaryUrls: readonly string[],
): "insert" | "update" {
  if (!open) return "insert";
  return newPrimaryUrls.every((u) => open.primaryUrls.includes(u)) ? "update" : "insert";
}
