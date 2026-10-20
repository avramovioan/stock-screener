// Delayed quotes for the held symbols through the P4 quote cache (`quote:<symbol>`, TTL 5 minutes). No Flex, no ad-hoc Yahoo calls
// for symbols that are fresh in the cache; a provider failure falls back to the stale cache and is reported, never hidden.
import type { FxRate, QuoteInfo } from "@core/portfolio-view.ts";

export const QUOTE_TTL_MS = 300_000;
/** A cached quote older than this is never served, not even as a provider-failure fallback: the statement mark is used instead. */
export const MAX_STALE_MS = 86_400_000;

const keyOf = (symbol: string): string => `quote:${symbol.toUpperCase()}`;

export interface CachedRow {
  payload: unknown;
  fetchedAt: number;
  expiresAt: number;
}

export interface QuoteKv {
  get(keys: string[]): Promise<Map<string, CachedRow>>;
  put(
    entries: Array<{ key: string; payload: unknown; fetchedAt: number; expiresAt: number }>,
  ): Promise<void>;
}

export interface MarketQuote {
  symbol: string;
  currency: string;
  exchange?: string | null;
  fullExchangeName?: string | null;
  longName?: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  regularMarketChangePercent: number | null;
  marketState: string | null;
}

export interface QuoteSource {
  quotes(
    symbols: readonly string[],
  ): Promise<{ map: Map<string, QuoteInfo>; error: string | null }>;
  fx(
    pairs: ReadonlyArray<{ from: string; to: string }>,
  ): Promise<{ map: Map<string, FxRate>; error: string | null }>;
}

interface Payload {
  symbol: string;
  currency: string;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  regularMarketChangePercent: number | null;
  marketState: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toInfo(symbol: string, row: CachedRow): QuoteInfo | null {
  const p = row.payload as Partial<Payload> | null;
  if (p === null || typeof p !== "object" || typeof p.currency !== "string") return null;
  return {
    symbol,
    price: num(p.regularMarketPrice),
    currency: p.currency,
    changePercent: num(p.regularMarketChangePercent),
    regularMarketTime: num(p.regularMarketTime),
    marketState: typeof p.marketState === "string" ? p.marketState : null,
    fetchedAtMs: row.fetchedAt,
  };
}

export function createCachedQuoteSource(deps: {
  kv: QuoteKv;
  market: { quote(symbols: string[]): Promise<MarketQuote[]> };
  nowMs: () => number;
}): QuoteSource {
  async function load(
    symbols: readonly string[],
  ): Promise<{ map: Map<string, QuoteInfo>; error: string | null }> {
    const wanted = [...new Set(symbols)];
    const out = new Map<string, QuoteInfo>();
    if (wanted.length === 0) return { map: out, error: null };
    const now = deps.nowMs();
    const cached = await deps.kv.get(wanted.map(keyOf));
    const missing: string[] = [];
    for (const s of wanted) {
      const row = cached.get(keyOf(s));
      const info = row === undefined ? null : toInfo(s, row);
      if (row !== undefined && info !== null && row.expiresAt > now) out.set(s, info);
      else missing.push(s);
    }
    if (missing.length === 0) return { map: out, error: null };
    try {
      const fetched = await deps.market.quote(missing);
      const entries = fetched.map((q) => ({
        key: keyOf(q.symbol),
        payload: { ...q, fetchedAt: new Date(now).toISOString(), stale: false },
        fetchedAt: now,
        expiresAt: now + QUOTE_TTL_MS,
      }));
      if (entries.length > 0) await deps.kv.put(entries);
      for (const q of fetched) {
        out.set(q.symbol, {
          symbol: q.symbol,
          price: q.regularMarketPrice,
          currency: q.currency,
          changePercent: q.regularMarketChangePercent,
          regularMarketTime: q.regularMarketTime,
          marketState: q.marketState,
          fetchedAtMs: now,
        });
      }
      return { map: out, error: null };
    } catch {
      for (const s of missing) {
        const row = cached.get(keyOf(s));
        const info = row === undefined ? null : toInfo(s, row);
        if (info !== null && row !== undefined && now - row.fetchedAt <= MAX_STALE_MS)
          out.set(s, info);
      }
      return { map: out, error: "quote_provider_unavailable" };
    }
  }

  return {
    quotes: load,
    async fx(pairs) {
      const symbols = pairs.map((p) => `${p.from}${p.to}=X`);
      const res = await load(symbols);
      const map = new Map<string, FxRate>();
      for (const p of pairs) {
        const q = res.map.get(`${p.from}${p.to}=X`);
        if (q === undefined || q.price === null || q.price <= 0) continue;
        map.set(`${p.from}>${p.to}`, {
          rate: q.price,
          rateDate: new Date(q.regularMarketTime ?? q.fetchedAtMs).toISOString().slice(0, 10),
          source: "yahoo",
        });
      }
      return { map, error: res.error };
    },
  };
}
