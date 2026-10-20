import { instrumentRejection, isLikelyDepositaryReceipt } from "./instruments.ts";
import { isUsExchange } from "./ranking.ts";

export interface ListingFact {
  securityId: string;
  symbol: string;
  exchange: string;
  venueClass: "primary" | "secondary_only" | "otc";
  exchangeCountry: string;
  longName: string | null;
  marketCapUsd: number | null;
  sharesOutstanding: number | null;
  avgUsdVolume30d: number | null;
  firstTradeDay: number | null;
  /** Yahoo quoteType. Absent or null is read as EQUITY (rows written before the column was loaded, tests). */
  quoteType?: string | null;
  /** Major trading currency (GBp -> GBP) and Yahoo financialCurrency; used to spot depositary receipts and foreign cross-lines. */
  currency?: string | null;
  financialCurrency?: string | null;
}

export type ListingRole =
  | "canonical"
  | "share_class"
  | "adr"
  | "foreign_listing"
  | "secondary_venue"
  | "excluded";

export type OverrideKind =
  | "force_canonical"
  | "exclude"
  | "force_us"
  | "force_not_us"
  | "merge_into_company"
  | "predecessor_continuity";

/** An active row of security_identity_overrides. `targetYahooSymbol` is the canonical symbol of target_company_id (merge_into_company). */
export interface Override {
  kind: OverrideKind;
  yahooSymbol: string;
  targetYahooSymbol?: string | null;
}

/** Two listings whose USD caps are within this relative gap are the same company (secondary lines carry the company's cap). */
export const CAP_MATCH_TOLERANCE = 0.15;
/** Gaps between the match tolerance and this value go to manual review. */
export const CAP_REVIEW_TOLERANCE = 0.4;
/** A canonical switch needs at least this volume ratio (A-06). */
export const DEFAULT_SWITCH_RATIO = 1.5;

const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "plc",
  "ag",
  "se",
  "sa",
  "nv",
  "bv",
  "spa",
  "ab",
  "asa",
  "oyj",
  "kk",
]);

/**
 * NFKD, strip diacritics, lower-case, "&" -> "and", drop punctuation, then drop a conservative trailing legal-form list.
 * Words such as "group" and "holding" are kept so distinct companies never merge.
 */
export function normalizeName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "") // "S.A." -> "SA", "N.V." -> "NV", "Moody's" -> "Moodys"
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const tokens = base.length === 0 ? [] : base.split(" ");
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1] as string)) tokens.pop();
  return tokens.join(" ");
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Relative gap of two caps in [0, 1]; null when either is unknown. */
function capGap(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !(a > 0) || !(b > 0)) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [low, high] = compareCodeUnits(ra, rb) <= 0 ? [ra, rb] : [rb, ra];
    this.parent.set(high, low);
  }
}

/**
 * Groups listings into companies.
 *   same normalised name AND caps unknown or within 15%       -> same company
 *   same normalised name AND caps 15-40% apart                -> needsReview ("cap_mismatch")
 *   equal sharesOutstanding only AND caps within 15%          -> needsReview ("shares_only")
 *   anything else                                             -> unrelated (including a name match with caps > 40% apart)
 * Overrides: `exclude` removes a listing from every group; `merge_into_company` unions a listing with its target.
 * Output is deterministic: members sorted by symbol, groups by their first symbol, review pairs by security id.
 */
export function groupListings(
  listings: ListingFact[],
  overrides: Override[],
): { groups: ListingFact[][]; needsReview: { a: string; b: string; why: string }[] } {
  const excluded = new Set(overrides.filter((o) => o.kind === "exclude").map((o) => o.yahooSymbol));
  const pool = listings
    .filter((l) => !excluded.has(l.symbol))
    .sort((x, y) => compareCodeUnits(x.symbol, y.symbol));
  const names = new Map<string, string>(
    pool.map((l) => [l.securityId, l.longName === null ? "" : normalizeName(l.longName)]),
  );
  const uf = new UnionFind();
  const review = new Map<string, { a: string; b: string; why: string }>();

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const x = pool[i] as ListingFact;
      const y = pool[j] as ListingFact;
      const nx = names.get(x.securityId) as string;
      const ny = names.get(y.securityId) as string;
      const nameEq = nx !== "" && nx === ny;
      const sharesEq = x.sharesOutstanding !== null && x.sharesOutstanding === y.sharesOutstanding;
      const gap = capGap(x.marketCapUsd, y.marketCapUsd);
      const [a, b] =
        compareCodeUnits(x.securityId, y.securityId) <= 0
          ? [x.securityId, y.securityId]
          : [y.securityId, x.securityId];
      if (nameEq) {
        if (gap === null || gap <= CAP_MATCH_TOLERANCE) uf.union(x.securityId, y.securityId);
        else if (gap <= CAP_REVIEW_TOLERANCE)
          review.set(`${a}|${b}`, { a, b, why: "cap_mismatch" });
      } else if (sharesEq && gap !== null && gap <= CAP_MATCH_TOLERANCE) {
        review.set(`${a}|${b}`, { a, b, why: "shares_only" });
      }
    }
  }

  const bySymbol = new Map(pool.map((l) => [l.symbol, l]));
  for (const o of overrides) {
    if (
      o.kind !== "merge_into_company" ||
      o.targetYahooSymbol === undefined ||
      o.targetYahooSymbol === null
    )
      continue;
    const from = bySymbol.get(o.yahooSymbol);
    const to = bySymbol.get(o.targetYahooSymbol);
    if (from !== undefined && to !== undefined) {
      uf.union(from.securityId, to.securityId);
      review.delete(`${[from.securityId, to.securityId].sort(compareCodeUnits).join("|")}`);
    }
  }

  const buckets = new Map<string, ListingFact[]>();
  for (const l of pool) {
    const root = uf.find(l.securityId);
    const list = buckets.get(root);
    if (list === undefined) buckets.set(root, [l]);
    else list.push(l);
  }
  const groups = [...buckets.values()].sort((g1, g2) =>
    compareCodeUnits((g1[0] as ListingFact).symbol, (g2[0] as ListingFact).symbol),
  );
  const needsReview = [...review.values()].sort(
    (p, q) => compareCodeUnits(p.a, q.a) || compareCodeUnits(p.b, q.b),
  );
  return { groups, needsReview };
}

export interface CanonicalOptions {
  /** Volume ratio a challenger needs to replace the current canonical (default 1.5). */
  switchRatio: number;
  /** True when the listing passes the 10-year and 2,500-bar tests. Defaults to "always passes". */
  isHistoryEligible?: (l: ListingFact) => boolean;
}

/** Why a company has no canonical listing and is left out of screening (A-50). */
export type ExclusionReason = "no_primary_listing" | "country_unknown" | "not_a_share";

export interface CanonicalResult {
  canonicalId: string | null;
  roles: Record<string, ListingRole>;
  flags: string[];
  /** Set exactly when canonicalId is null. */
  exclusion: ExclusionReason | null;
  /** The home country taken from the only primary listing when the company country is unknown. */
  inferredCountry?: string | null;
}

/**
 * Exchange countries that also count as a home when the company country is the key (second tier, after an exact match).
 * Yahoo gives a mainland-China headquarters (Tencent) while the HKEX seed says "Hong Kong".
 */
const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  China: ["Hong Kong"],
  "Hong Kong": ["China"],
};

/** Among home listings of one country the lower number is the primary one: NSE over BSE (A-50). Other exchanges rank 0. */
const EXCHANGE_PRIORITY: Readonly<Record<string, number>> = { NSI: 0, BSE: 1 };

/** null = not a home listing; otherwise a rank (exact country before an aliased country, then the exchange priority). */
function homeRank(l: ListingFact, homeCountry: string): number | null {
  const exact = l.exchangeCountry === homeCountry;
  const aliased = !exact && (COUNTRY_ALIASES[homeCountry] ?? []).includes(l.exchangeCountry);
  if (!exact && !aliased) return null;
  return (exact ? 0 : 10) + (EXCHANGE_PRIORITY[l.exchange] ?? 0);
}

/**
 * Canonical listing of one company (5.6, A-50). Only the company own primary listing is ever screened; there is no fallback to a
 * foreign line.
 * 1. Never candidates: anything that is not a common share (quoteType other than EQUITY or a bond-like name: role excluded), London
 *    international order book lines (symbol 0xxx.L: secondary_venue), non-primary venues (secondary_venue), OTC (excluded).
 * 2. Home country: the company own country; when unknown, the exchange country shared by all eligible listings that are not
 *    depositary-receipt-like or foreign cross-lines, else the company is excluded (country_unknown).
 * 3. Candidates = the best-ranked home listings (exact country before alias, then NSE over BSE). Without a home listing: the
 *    ordinary shares on NYSE or Nasdaq (not an ADR/ADS/GDR, see isLikelyDepositaryReceipt). Anything else foreign (ADR, Xetra, BDR,
 *    London line) is never canonical: no candidate means the company is excluded (no_primary_listing).
 * 4. Among candidates the highest avgUsdVolume30d wins, ties ascending symbol, missing volume last; all missing keeps current or the
 *    first symbol (flag canonical_unverified).
 * 5. Hysteresis: a switch away from current needs switchRatio x its volume and a history-eligible challenger. It applies only when
 *    current is itself a candidate; a current canonical that breaks the rule is replaced at once.
 * 6. An ADR is never canonical (it is foreign by rule 3).
 */
export function chooseCanonical(
  group: ListingFact[],
  homeCountry: string | null,
  current: { securityId: string } | null,
  opts: CanonicalOptions,
): CanonicalResult {
  const roles: Record<string, ListingRole> = {};
  const flags: string[] = [];
  const exclude = (exclusion: ExclusionReason): CanonicalResult => {
    flags.push(exclusion);
    return { canonicalId: null, roles, flags, exclusion };
  };

  const eligible: ListingFact[] = [];
  let shares = 0;
  for (const l of group) {
    const rejection = instrumentRejection({
      symbol: l.symbol,
      quoteType: l.quoteType ?? "EQUITY",
      name: l.longName,
    });
    if (rejection === "not_equity" || rejection === "bond_like" || rejection === "fund_like") {
      roles[l.securityId] = "excluded";
      continue;
    }
    shares += 1;
    if (rejection === "iob_line" || rejection === "bdr_line")
      roles[l.securityId] = "secondary_venue";
    else if (l.venueClass === "otc") roles[l.securityId] = "excluded";
    else if (l.venueClass !== "primary") roles[l.securityId] = "secondary_venue";
    else eligible.push(l);
  }
  if (shares === 0 && group.length > 0) return exclude("not_a_share");

  const isAdrLike = (l: ListingFact): boolean =>
    isLikelyDepositaryReceipt({
      name: l.longName,
      currencyMajor: l.currency,
      financialCurrency: l.financialCurrency,
    });

  let country = homeCountry;
  let inferredCountry: string | null = null;
  if (country === null) {
    // lines that look like depositary receipts or foreign cross-lines (trading currency != reporting currency) say nothing about the home
    const countries = new Set(eligible.filter((l) => !isAdrLike(l)).map((l) => l.exchangeCountry));
    if (countries.size !== 1) return exclude("country_unknown");
    country = [...countries][0] as string;
    inferredCountry = country;
  }
  const home = country;

  const ranked: Array<{ l: ListingFact; rank: number }> = [];
  const foreign: ListingFact[] = [];
  for (const l of eligible) {
    const rank = homeRank(l, home);
    if (rank === null) foreign.push(l);
    else ranked.push({ l, rank });
  }
  // (b) no home listing: the ordinary shares on a main exchange (NYSE, Nasdaq), never a depositary receipt
  const mainExchange =
    ranked.length === 0 ? foreign.filter((l) => isUsExchange(l.exchange) && !isAdrLike(l)) : [];
  if (ranked.length === 0 && mainExchange.length === 0) {
    for (const l of foreign) roles[l.securityId] = "excluded";
    return exclude("no_primary_listing");
  }
  if (mainExchange.length > 0) {
    flags.push("main_exchange_listing");
    for (const l of mainExchange) ranked.push({ l, rank: 0 });
    foreign.splice(0, foreign.length, ...foreign.filter((l) => !mainExchange.includes(l)));
  }
  const bestRank = Math.min(...ranked.map((x) => x.rank));
  const candidates = ranked.filter((x) => x.rank === bestRank).map((x) => x.l);
  const lowerHome = ranked.filter((x) => x.rank !== bestRank).map((x) => x.l);

  const volume = (l: ListingFact): number | null =>
    l.avgUsdVolume30d !== null && Number.isFinite(l.avgUsdVolume30d) ? l.avgUsdVolume30d : null;
  const byVolume = [...candidates].sort((a, b) => {
    const va = volume(a);
    const vb = volume(b);
    if (va !== null && vb !== null && va !== vb) return vb - va;
    if (va !== null && vb === null) return -1;
    if (va === null && vb !== null) return 1;
    return compareCodeUnits(a.symbol, b.symbol);
  });
  const allMissing = candidates.every((c) => volume(c) === null);
  const currentListing =
    current === null ? undefined : candidates.find((c) => c.securityId === current.securityId);
  let chosen = byVolume[0] as ListingFact;

  if (allMissing) {
    flags.push("canonical_unverified");
    if (currentListing !== undefined) chosen = currentListing;
  } else if (currentListing !== undefined && chosen.securityId !== currentListing.securityId) {
    const challenger = volume(chosen) ?? 0;
    const incumbent = volume(currentListing) ?? 0;
    const eligibleChallenger =
      opts.isHistoryEligible === undefined ? true : opts.isHistoryEligible(chosen);
    if (challenger >= opts.switchRatio * incumbent && eligibleChallenger) {
      flags.push("canonical_switched");
    } else {
      flags.push("canonical_switch_blocked");
      chosen = currentListing;
    }
  }

  for (const l of candidates)
    roles[l.securityId] = l.securityId === chosen.securityId ? "canonical" : "share_class";
  for (const l of lowerHome) roles[l.securityId] = "share_class";
  for (const l of foreign)
    roles[l.securityId] = isUsExchange(l.exchange) ? "adr" : "foreign_listing";
  return { canonicalId: chosen.securityId, roles, flags, exclusion: null, inferredCountry };
}

/** Applies a `force_canonical` override (by yahoo symbol) after the algorithm; it wins over volume and hysteresis. */
export function applyForceCanonical(
  group: ListingFact[],
  result: CanonicalResult,
  overrides: Override[],
): CanonicalResult {
  const forced = overrides.find(
    (o) => o.kind === "force_canonical" && group.some((l) => l.symbol === o.yahooSymbol),
  );
  if (forced === undefined) return result;
  const target = group.find((l) => l.symbol === forced.yahooSymbol) as ListingFact;
  const roles = { ...result.roles };
  for (const [id, role] of Object.entries(roles)) {
    if (role === "canonical") roles[id] = "share_class";
  }
  roles[target.securityId] = "canonical";
  return {
    canonicalId: target.securityId,
    roles,
    flags: [...result.flags, "canonical_forced"],
    exclusion: null,
    inferredCountry: result.inferredCountry ?? null,
  };
}
