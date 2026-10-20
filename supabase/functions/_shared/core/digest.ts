// Digest assembly and rendering (spec 4.10, 10.1, 10.7). Web Push is the only channel. Pure: no I/O, no clocks, no randomness.

import type { UniverseMode } from "./thresholds.ts";
export type DigestKind = "discounts" | "portfolio";

export interface DiscountEntry {
  episodeId: string;
  companyId: string;
  securityId: string;
  mode: UniverseMode;
  alsoIn: UniverseMode[];
  rank: number;
  yahooSymbol: string;
  /** Home ticker of the listing (spec 5.5); entries without it show the Yahoo symbol. */
  ticker?: string;
  name: string;
  close: number;
  ccy: string;
  sessionDate: string;
  /** The line that triggered the episode: "-3" for every new one, "-4" only on a legacy episode. */
  line: "-3" | "-4";
  /** Worldwide rank 1-10: "Strong buy". */
  isTop10: boolean;
  /** close <= the -4 line (informational depth; the -3 line is the trigger). */
  reachedLine4: boolean;
  /** The outcome of a complete report; null when the company is not researched yet. */
  category: "green" | "amber" | "red" | "grey" | null;
  conclusion: string;
  bankruptcyRisk: string;
  summary: string;
  eur: { symbol: string; status: "verified" | "unverified" | "none" } | null;
}

export interface PortfolioEntry {
  key: string;
  securityId: string;
  yahooSymbol: string;
  name: string;
  priceSignals: ("premium1" | "premium2")[];
  riskFindingIds: string[];
  researchStatus: string;
}

/** Display facts for the renderers; the spec's PortfolioEntry stays unchanged. */
export interface PortfolioSignalView {
  kind: "premium1" | "premium2";
  close: number;
  ccy: string;
  sessionDate: string;
}
export interface PortfolioRiskView {
  id: string;
  category: string;
  summary: string;
  detectedOn: string;
}
export interface PortfolioEntryView extends PortfolioEntry {
  signals: PortfolioSignalView[];
  risks: PortfolioRiskView[];
}

export const PUSH_PAYLOAD_MAX_BYTES = 3500;
const MODE_ORDER: readonly UniverseMode[] = ["worldwide", "us"];

// ---------------------------------------------------------------------------------------------
// canonicalJson

function canon(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canon(v) ?? "null").join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canon(record[key]);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

/** Sorted keys, no whitespace; the caller hashes it for digests.content_hash. */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? "null";
}

// ---------------------------------------------------------------------------------------------
// Ordering and assembly

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tickerOf(e: Pick<DiscountEntry, "ticker" | "yahooSymbol">): string {
  return e.ticker ?? e.yahooSymbol;
}

/** Green, amber, other outcomes, not researched; then rank ascending; then yahooSymbol ascending (code-unit order). */
export function orderDiscountEntries(entries: DiscountEntry[]): DiscountEntry[] {
  const weight = (e: DiscountEntry) =>
    e.category === "green" ? 0 : e.category === "amber" ? 1 : e.category === null ? 3 : 2;
  return [...entries].sort(
    (a, b) =>
      weight(a) - weight(b) || a.rank - b.rank || codeUnitCompare(a.yahooSymbol, b.yahooSymbol),
  );
}

function modeIndex(mode: UniverseMode): number {
  return MODE_ORDER.indexOf(mode);
}

export function buildDiscountDigest(
  entries: DiscountEntry[],
  prefs: { modes: UniverseMode[]; sendEmpty: boolean },
): { items: DiscountEntry[]; skipReason: string | null } {
  const wanted = entries.filter((e) => prefs.modes.includes(e.mode));
  const byCompany = new Map<string, DiscountEntry[]>();
  for (const entry of wanted) {
    const group = byCompany.get(entry.companyId) ?? [];
    group.push(entry);
    byCompany.set(entry.companyId, group);
  }
  const merged: DiscountEntry[] = [];
  for (const group of byCompany.values()) {
    const sorted = [...group].sort((a, b) => modeIndex(a.mode) - modeIndex(b.mode));
    const primary = sorted[0];
    if (primary === undefined) continue;
    const also = new Set<UniverseMode>(primary.alsoIn);
    for (const other of sorted.slice(1)) {
      if (other.mode !== primary.mode) also.add(other.mode);
      for (const m of other.alsoIn) if (m !== primary.mode) also.add(m);
    }
    merged.push({ ...primary, alsoIn: [...also].sort((a, b) => modeIndex(a) - modeIndex(b)) });
  }
  const items = orderDiscountEntries(merged);
  return { items, skipReason: items.length === 0 && !prefs.sendEmpty ? "empty" : null };
}

function unionSignals(
  a: PortfolioEntry["priceSignals"],
  b: PortfolioEntry["priceSignals"],
): PortfolioEntry["priceSignals"] {
  const set = new Set([...a, ...b]);
  return (["premium1", "premium2"] as const).filter((s) => set.has(s));
}

function mergePortfolio<T extends PortfolioEntry>(a: T, b: T): T {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...left };
  merged.priceSignals = unionSignals(a.priceSignals, b.priceSignals);
  merged.riskFindingIds = [...new Set([...a.riskFindingIds, ...b.riskFindingIds])].sort();
  for (const field of ["signals", "risks"]) {
    const av = left[field];
    const bv = right[field];
    if (Array.isArray(av) || Array.isArray(bv)) {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of [...(Array.isArray(av) ? av : []), ...(Array.isArray(bv) ? bv : [])]) {
        const id = canonicalJson(item);
        if (!seen.has(id)) {
          seen.add(id);
          out.push(item);
        }
      }
      merged[field] = out;
    }
  }
  return merged as unknown as T;
}

/** One entry per holding (key): a premium event and a risk finding of one security are combined. */
export function buildPortfolioDigest<T extends PortfolioEntry>(
  entries: T[],
  sendEmpty: boolean,
): { items: T[]; skipReason: string | null } {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    byKey.set(entry.key, existing === undefined ? entry : mergePortfolio(existing, entry));
  }
  const items = [...byKey.values()].sort((a, b) => codeUnitCompare(a.yahooSymbol, b.yahooSymbol));
  return { items, skipReason: items.length === 0 && !sendEmpty ? "empty" : null };
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  const budget = maxBytes - 3; // room for the ellipsis
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = utf8Length(ch);
    if (used + size > budget) break;
    used += size;
    out += ch;
  }
  return `${out}…`;
}

function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

// ---------------------------------------------------------------------------------------------
// Topic and push payload

/** Web Push Topic and notification tag. URL-safe base64 alphabet, at most 32 characters: no colon. */
export function digestTopic(kind: DigestKind): string {
  return `digest-${kind}`;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function pushPayload(
  kind: "discounts",
  items: readonly DiscountEntry[],
  siteUrl: string,
  opts?: { maxBodyChars?: number },
): PushPayload;
export function pushPayload(
  kind: "portfolio",
  items: readonly PortfolioEntryView[],
  siteUrl: string,
  opts?: { maxBodyChars?: number },
): PushPayload;
export function pushPayload(
  kind: DigestKind,
  items: readonly DiscountEntry[] | readonly PortfolioEntryView[],
  siteUrl: string,
  opts: { maxBodyChars?: number } = {},
): PushPayload {
  const base = siteUrl.replace(/\/+$/, "");
  let source: string;
  let title: string;
  if (kind === "discounts") {
    const list = items as readonly DiscountEntry[];
    const n = list.length;
    const head = list
      .slice(0, 3)
      .map((e) => `#${e.rank} ${tickerOf(e)}`)
      .join(", ");
    const more = n > 3 ? `, +${n - 3} more` : "";
    const risk = list.some((e) => e.category === "amber") ? " (includes higher risk)" : "";
    const strong = list.filter((e) => e.isTop10).length;
    const strongNote = strong > 0 ? ` (${strong} strong buy)` : "";
    source =
      n === 0
        ? "No new discounts today"
        : `${n} new discount${n === 1 ? "" : "s"}: ${head}${more}${strongNote}${risk}`;
    title = "Today's discounts";
  } else {
    const list = items as readonly PortfolioEntryView[];
    const parts = list.slice(0, 3).map((e) => {
      const kinds = [
        ...e.priceSignals.map((s) => (s === "premium2" ? "premium +2" : "premium +1")),
        ...(e.riskFindingIds.length > 0 ? ["risk"] : []),
      ];
      return `${e.yahooSymbol} ${kinds.join(" and ")}`;
    });
    const more = list.length > 3 ? `, +${list.length - 3} more` : "";
    source = list.length === 0 ? "No portfolio alerts today" : `${parts.join(", ")}${more}`;
    title = "Portfolio alerts";
  }
  const url = `${base}${kind === "discounts" ? "/" : "/portfolio"}`;
  const tag = digestTopic(kind);
  let body = truncateChars(source, opts.maxBodyChars ?? 140);
  let limit = utf8Length(body);
  while (utf8Length(JSON.stringify({ title, body, url, tag })) > PUSH_PAYLOAD_MAX_BYTES) {
    if (limit <= 0) throw new Error("push payload metadata exceeds the size cap");
    limit = Math.floor(limit * 0.9);
    body = truncateUtf8(source, limit);
  }
  return { title, body, url, tag };
}
