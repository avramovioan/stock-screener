import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { type EurExchange, isValidLocalSymbol } from "../../_shared/core/handoff.ts";
import { normalizeName } from "../../_shared/core/identity.ts";

/**
 * Pure matching and verification rules of spec 5.7. The EUR line is a display and hand-off convenience: nothing here ever feeds screening.
 * A candidate is `verified` only when every required check passes (A-28); a hard mismatch (different company, not an equity, not EUR,
 * different share count) rejects the candidate outright; missing data or a price outside the tolerance leaves it `unverified`.
 */

export const NAME_SIMILARITY_MIN = 0.9;
export const PRICE_TOLERANCE = 0.01; // A-28: price x FX within 1%
export const PROBE_SUFFIX: Readonly<Record<EurExchange, string>> = { IBIS: ".DE", AEB: ".AS" };

export type CheckName =
  | "isin_confirmed"
  | "currency_eur"
  | "quote_type_equity"
  | "name_match"
  | "shares_outstanding"
  | "price_within_tolerance"
  | "local_symbol_format";
export type CheckResult = "pass" | "fail" | "not_available";
export type CandidateBasis = "isin" | "description" | "symbol";

/** Hard failures reject the candidate: the Yahoo line is positively a different instrument. */
const HARD: ReadonlySet<CheckName> = new Set([
  "isin_confirmed",
  "currency_eur",
  "quote_type_equity",
  "name_match",
  "shares_outstanding",
]);
const ALWAYS_REQUIRED: readonly CheckName[] = [
  "isin_confirmed",
  "currency_eur",
  "quote_type_equity",
  "name_match",
  "price_within_tolerance",
  "local_symbol_format",
];

export interface CatalogueCandidate {
  exchange_id: EurExchange;
  conid: number;
  symbol: string;
  local_symbol: string;
  isin: string | null;
  description: string | null;
}

export interface CanonicalSecurity {
  id: string;
  yahooSymbol: string;
  currency: string; // as Yahoo quotes it, may be a minor unit (GBp)
  currencyMajor: string;
  minorDivisor: number;
  longName: string | null;
  companyName: string;
  sharesOutstanding: number | null;
  isin: string | null;
}

export interface FxPair {
  eurUsd: number | null;
  ccyUsd: number | null; // usdPerUnit of the canonical security's major currency
  rateDate: string | null;
}

export interface Verification {
  method: "automatic" | "manual_override";
  checked_at: string;
  basis: CandidateBasis | null;
  similarity: number | null;
  probe_symbol: string | null;
  checks: Record<CheckName, CheckResult>;
  failed: string[];
  hard_failed: string[];
  price_deviation_pct: number | null;
  fx: { ccy: string; rate_date: string | null; eur_usd: number | null; ccy_usd: number | null };
  notes: string[];
}

export interface Assessment {
  outcome: "verified" | "unverified" | "rejected";
  verification: Verification;
}

// ---------------------------------------------------------------------------------------------- small pure helpers

/** `MSFT` -> `MSFT`, `SAP.DE` -> `SAP`, `BRK-B` -> `BRK-B`. */
export function baseTicker(yahooSymbol: string): string {
  return (yahooSymbol.split(".")[0] ?? yahooSymbol).toUpperCase();
}

export function probeSymbol(exchange: EurExchange, localSymbol: string): string {
  return `${localSymbol.toUpperCase()}${PROBE_SUFFIX[exchange]}`;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] as number;
      prev[j] = Math.min(
        above + 1,
        (prev[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prev[b.length] as number;
}

/** 1 - edit distance / longer length, on `normalizeName` output. Two empty names are not similar. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === "" || y === "") return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** Relative gap of the EUR line's implied price to the canonical price, both in major units: (implied - canonical) / canonical. */
export function priceDeviation(input: {
  eurPrice: number | null;
  canonicalPrice: number | null;
  canonicalMinorDivisor: number;
  canonicalMajor: string;
  fx: FxPair;
}): number | null {
  const { eurPrice, canonicalPrice, fx } = input;
  if (eurPrice === null || canonicalPrice === null || !(eurPrice > 0) || !(canonicalPrice > 0))
    return null;
  const canonicalMajorPrice = canonicalPrice / input.canonicalMinorDivisor;
  let implied: number;
  if (input.canonicalMajor === "EUR") {
    implied = eurPrice;
  } else {
    if (fx.eurUsd === null || fx.ccyUsd === null || !(fx.eurUsd > 0) || !(fx.ccyUsd > 0))
      return null;
    implied = (eurPrice * fx.eurUsd) / fx.ccyUsd;
  }
  return (implied - canonicalMajorPrice) / canonicalMajorPrice;
}

/** "2026-10-15" -> "2026-W42" (ISO 8601 week; the week-numbering year can differ from the calendar year around New Year). */
export function isoWeek(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) throw new RangeError(`isoWeek: expected YYYY-MM-DD, got ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // the Thursday of this ISO week decides the year
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------- candidate selection

export interface BasisMatch {
  basis: CandidateBasis;
  similarity: number | null;
}

/** Why a catalogue row is a candidate for `security` (spec 5.7 step 1), or null. ISIN beats description beats ticker. */
export function matchBasis(
  security: CanonicalSecurity,
  knownIsins: readonly string[],
  c: CatalogueCandidate,
): BasisMatch | null {
  const similarity =
    c.description === null
      ? null
      : nameSimilarity(c.description, security.longName ?? security.companyName);
  if (c.isin !== null && knownIsins.includes(c.isin)) return { basis: "isin", similarity };
  if (similarity !== null && similarity >= NAME_SIMILARITY_MIN)
    return { basis: "description", similarity };
  if (c.symbol.toUpperCase() === baseTicker(security.yahooSymbol))
    return { basis: "symbol", similarity };
  return null;
}

const BASIS_RANK: Record<CandidateBasis, number> = { isin: 0, description: 1, symbol: 2 };
const EXCHANGE_RANK: Record<EurExchange, number> = { IBIS: 0, AEB: 1 };

export interface RankedCandidate {
  candidate: CatalogueCandidate;
  match: BasisMatch;
}

/** Stable order: IBIS before AEB, then basis strength, then higher similarity, then lower conid; at most `perExchange` per exchange. */
export function rankCandidates(
  items: readonly RankedCandidate[],
  perExchange: number,
): RankedCandidate[] {
  const sorted = [...items].sort(
    (a, b) =>
      EXCHANGE_RANK[a.candidate.exchange_id] - EXCHANGE_RANK[b.candidate.exchange_id] ||
      BASIS_RANK[a.match.basis] - BASIS_RANK[b.match.basis] ||
      (b.match.similarity ?? 0) - (a.match.similarity ?? 0) ||
      a.candidate.conid - b.candidate.conid,
  );
  const taken: Record<EurExchange, number> = { IBIS: 0, AEB: 0 };
  return sorted.filter((i) => taken[i.candidate.exchange_id]++ < perExchange);
}

// ---------------------------------------------------------------------------------------------- assessment

export interface AssessInput {
  security: CanonicalSecurity;
  securityQuote: QuoteRecord | null; // the canonical line, quoted in the same call as the probe
  candidate: CatalogueCandidate;
  match: BasisMatch;
  knownIsins: readonly string[];
  /** Result of Yahoo `search(candidate.isin)`: the primary symbol, null when no hit, "unavailable" when the call failed or there is no ISIN. */
  isinSearch: { primarySymbol: string | null } | "unavailable";
  probe: QuoteRecord | null;
  fx: FxPair;
  requireShares: boolean;
  nowMs: number;
}

const sameName = (a: string, b: string): boolean =>
  normalizeName(a) === normalizeName(b) && normalizeName(a) !== "";

export function assessCandidate(i: AssessInput): Assessment {
  const { security, candidate, probe } = i;
  const notes: string[] = [];
  const checks = {} as Record<CheckName, CheckResult>;

  // 1. ISIN confirmation: Yahoo's search(ISIN) returns the primary listing only (spike 3.5); it must be the canonical symbol.
  if (
    candidate.isin === null ||
    i.isinSearch === "unavailable" ||
    i.isinSearch.primarySymbol === null
  ) {
    checks.isin_confirmed = "not_available";
    notes.push(candidate.isin === null ? "candidate_without_isin" : "isin_search_unavailable");
  } else if (i.isinSearch.primarySymbol.toUpperCase() !== security.yahooSymbol.toUpperCase()) {
    checks.isin_confirmed = "fail";
    notes.push(`isin_primary_is_${i.isinSearch.primarySymbol}`);
  } else if (i.knownIsins.length > 0 && !i.knownIsins.includes(candidate.isin)) {
    checks.isin_confirmed = "fail";
    notes.push("isin_differs_from_known_isin");
  } else {
    checks.isin_confirmed = "pass";
  }

  // 2. The Yahoo line of the EUR listing.
  checks.currency_eur =
    probe === null ? "not_available" : probe.currency === "EUR" ? "pass" : "fail";
  checks.quote_type_equity =
    probe === null ? "not_available" : probe.quoteType === "EQUITY" ? "pass" : "fail";
  if (probe === null) notes.push("no_yahoo_line");

  const canonicalName = i.securityQuote?.longName ?? security.longName ?? security.companyName;
  checks.name_match =
    probe === null || probe.longName === null || canonicalName === ""
      ? "not_available"
      : sameName(probe.longName, canonicalName)
        ? "pass"
        : "fail";

  const canonicalShares = i.securityQuote?.sharesOutstanding ?? security.sharesOutstanding;
  checks.shares_outstanding =
    probe === null || probe.sharesOutstanding === null || canonicalShares === null
      ? "not_available"
      : probe.sharesOutstanding === canonicalShares
        ? "pass"
        : "fail";

  const deviation = priceDeviation({
    eurPrice: probe?.regularMarketPrice ?? null,
    canonicalPrice: i.securityQuote?.regularMarketPrice ?? null,
    canonicalMinorDivisor: security.minorDivisor,
    canonicalMajor: security.currencyMajor,
    fx: i.fx,
  });
  checks.price_within_tolerance =
    deviation === null ? "not_available" : Math.abs(deviation) <= PRICE_TOLERANCE ? "pass" : "fail";
  checks.local_symbol_format = isValidLocalSymbol(candidate.local_symbol) ? "pass" : "fail";

  const required = new Set<CheckName>(ALWAYS_REQUIRED);
  if (i.requireShares) required.add("shares_outstanding");
  const names = Object.keys(checks) as CheckName[];
  const hardFailed = names.filter((n) => checks[n] === "fail" && HARD.has(n));
  const failed = names.filter(
    (n) => checks[n] === "fail" || (checks[n] === "not_available" && required.has(n)),
  );

  return {
    outcome: hardFailed.length > 0 ? "rejected" : failed.length === 0 ? "verified" : "unverified",
    verification: {
      method: "automatic",
      checked_at: new Date(i.nowMs).toISOString(),
      basis: i.match.basis,
      similarity: i.match.similarity === null ? null : Math.round(i.match.similarity * 1000) / 1000,
      probe_symbol: probe?.symbol ?? probeSymbol(candidate.exchange_id, candidate.local_symbol),
      checks,
      failed,
      hard_failed: hardFailed,
      price_deviation_pct: deviation === null ? null : Math.round(deviation * 100_000) / 1000,
      fx: {
        ccy: security.currencyMajor,
        rate_date: i.fx.rateDate,
        eur_usd: i.fx.eurUsd,
        ccy_usd: i.fx.ccyUsd,
      },
      notes,
    },
  };
}
