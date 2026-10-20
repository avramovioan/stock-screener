// Matching Flex positions to Yahoo securities (spec 12.7). Pure over injected ports; never guesses.
import type { MatchSummary } from "./types.ts";

export interface PositionRef {
  id: number;
  conid: number;
  isin: string | null;
  symbol: string;
  listingExchange: string | null;
  currency: string;
  assetClass: string | null;
  subCategory: string | null;
}

export interface SecurityLite {
  id: string;
  yahoo_symbol: string;
  exchange_code: string;
  currency_major: string;
  quote_type: string;
  company_id: string;
  isin: string | null;
  is_canonical: boolean;
}

export interface MatchPorts {
  securitiesByIsin(isin: string): Promise<SecurityLite[]>;
  securityBySymbol(yahooSymbol: string): Promise<SecurityLite | null>;
  /** `exchanges.ibkr_exchange_id` -> exchange code and Yahoo suffix ('' or null for NASDAQ/NYSE) */
  exchangeByIbkrId(
    ibkrExchangeId: string,
  ): Promise<{ code: string; yahooSuffix: string | null } | null>;
  canonicalOf(companyId: string): Promise<SecurityLite | null>;
  setSecurityIsin(securityId: string, isin: string): Promise<void>;
  searchIsin(
    isin: string,
  ): Promise<Array<{ symbol: string; quoteType: string; exchange?: string }>>;
  ensureSecurity(yahooSymbol: string): Promise<SecurityLite | { error: string }>;
}

export interface MatchStore {
  /** positions of the latest snapshot whose match_status is still 'unmatched' */
  positionsToMatch(userId: string): Promise<PositionRef[]>;
  applyOutcome(userId: string, outcome: MatchOutcome): Promise<void>;
}

export interface MatchOutcome {
  positionId: number;
  securityId: string | null;
  signalSecurityId: string | null;
  matchStatus: "matched_isin" | "matched_symbol_exchange" | "unmatched" | "not_equity";
  reason: string | null;
}

const FUND_LIKE = /^(ETF|ETN|FUND|MUTUAL|ETC)/i;

/** IBKR writes share classes with a space ("BRK B"); Yahoo uses a dash. The exchange suffix comes from `exchanges.yahoo_suffix`. */
export function yahooSymbolFor(flexSymbol: string, suffix: string | null): string {
  return `${flexSymbol.trim().toUpperCase().replace(/\s+/g, "-")}${suffix ?? ""}`;
}

/** Exchange 4 points, position currency 2, canonical 1; ties by symbol (UTF-16 order). */
export function pickLine(
  cands: readonly SecurityLite[],
  p: PositionRef,
  exchangeCode: string | null,
): SecurityLite | null {
  const score = (s: SecurityLite): number =>
    (exchangeCode !== null && s.exchange_code === exchangeCode ? 4 : 0) +
    (s.currency_major === p.currency.toUpperCase() ? 2 : 0) +
    (s.is_canonical ? 1 : 0);
  const sorted = [...cands].sort(
    (a, b) =>
      score(b) - score(a) ||
      (a.yahoo_symbol < b.yahoo_symbol ? -1 : a.yahoo_symbol > b.yahoo_symbol ? 1 : 0),
  );
  return sorted[0] ?? null;
}

export async function matchPosition(p: PositionRef, ports: MatchPorts): Promise<MatchOutcome> {
  const none = (matchStatus: MatchOutcome["matchStatus"], reason: string): MatchOutcome => ({
    positionId: p.id,
    securityId: null,
    signalSecurityId: null,
    matchStatus,
    reason,
  });
  if (p.assetClass !== null && p.assetClass.toUpperCase() !== "STK")
    return none("not_equity", "asset_class_not_stk");

  const exchange =
    p.listingExchange === null ? null : await ports.exchangeByIbkrId(p.listingExchange);
  let line: SecurityLite | null = null;
  let status: "matched_isin" | "matched_symbol_exchange" = "matched_isin";
  let reason: string | null = null;

  if (p.isin !== null) {
    line = pickLine(await ports.securitiesByIsin(p.isin), p, exchange?.code ?? null);
    if (line === null) {
      // the ISIN fallback only accepts a hit that agrees with the Flex position (listing exchange when known, and currency): never a guess
      const hits = (await ports.searchIsin(p.isin)).filter(
        (h) => exchange === null || h.exchange === undefined || h.exchange === exchange.code,
      );
      const top = hits[0];
      if (top !== undefined) {
        let found = await ports.securityBySymbol(top.symbol);
        if (found === null) {
          const created = await ports.ensureSecurity(top.symbol);
          if ("error" in created) reason = created.error;
          else found = created;
        }
        if (found !== null) {
          const agrees =
            found.currency_major === p.currency.toUpperCase() &&
            (exchange === null || found.exchange_code === exchange.code);
          if (agrees) {
            if (found.isin === null) await ports.setSecurityIsin(found.id, p.isin);
            line = found;
          } else reason = "listing_mismatch";
        }
      }
    }
  }
  if (line === null && exchange !== null) {
    status = "matched_symbol_exchange";
    line = await ports.securityBySymbol(yahooSymbolFor(p.symbol, exchange.yahooSuffix));
  }
  if (line === null) return none("unmatched", reason ?? "no_match");

  const canonical = await ports.canonicalOf(line.company_id);
  const equity =
    line.quote_type === "EQUITY" && !(p.subCategory !== null && FUND_LIKE.test(p.subCategory));
  return {
    positionId: p.id,
    securityId: line.id,
    signalSecurityId: equity ? (canonical ?? line).id : null,
    matchStatus: equity ? status : "not_equity",
    reason: equity ? null : "not_an_equity",
  };
}

/** Never-attempted positions first, then the retries rotated by `seed` (e.g. the day), so more than `limit` persistent misses cannot starve each other. */
export function orderForMatching<T extends { id: number; attempted: boolean }>(
  rows: readonly T[],
  seed: number,
): T[] {
  const byId = [...rows].sort((x, y) => x.id - y.id);
  const fresh = byId.filter((r) => !r.attempted);
  const retried = byId.filter((r) => r.attempted);
  const k = retried.length === 0 ? 0 : ((seed % retried.length) + retried.length) % retried.length;
  return [...fresh, ...retried.slice(k), ...retried.slice(0, k)];
}

/** Matches the still-unmatched positions of one user (bounded: Yahoo is throttled). */
export async function matchUserPositions(
  userId: string,
  store: MatchStore,
  ports: MatchPorts,
  limit = 30,
): Promise<MatchSummary> {
  const summary: MatchSummary = { matched: 0, unmatched: 0, notEquity: 0 };
  for (const p of (await store.positionsToMatch(userId)).slice(0, limit)) {
    const outcome = await matchPosition(p, ports);
    await store.applyOutcome(userId, outcome);
    if (outcome.matchStatus === "not_equity") summary.notEquity += 1;
    else if (outcome.matchStatus === "unmatched") summary.unmatched += 1;
    else summary.matched += 1;
  }
  return summary;
}
