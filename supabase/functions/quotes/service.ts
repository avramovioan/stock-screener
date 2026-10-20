import { logError } from "@adapters/log.ts";
import type { CacheEntry, CacheStore } from "./cache.ts";
import type { ChartCompact, QuoteCore, QuoteDto, QuotesProvider, SearchHitDto } from "./types.ts";

export const LOCK_TTL_MS = 20_000;
export const TTL = { search: 3_600_000, quote: 300_000, chart: 86_400_000 } as const;

export interface Deps {
  provider: QuotesProvider;
  store: CacheStore;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
export interface Cached<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
}
export class BusyError extends Error {}

/**
 * Cache-aside with single-flight. A fresh hit is returned as is. On a miss exactly one caller takes
 * `lock:<key>`; the others get the (stale) cached value, or wait briefly, then BusyError.
 * If the provider fails, a stale value is served when one exists.
 */
export async function getOrFetch<T>(
  deps: Deps,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<Cached<T>> {
  const hit = await deps.store.get(key);
  if (hit && hit.expiresAt > deps.now())
    return { value: hit.payload as T, fetchedAt: hit.fetchedAt, stale: false };
  const got = await deps.store.tryLock(key, deps.now(), LOCK_TTL_MS);
  if (!got) {
    if (hit) return { value: hit.payload as T, fetchedAt: hit.fetchedAt, stale: true };
    for (let i = 0; i < 3; i++) {
      await deps.sleep(300);
      const again = await deps.store.get(key);
      if (again && again.expiresAt > deps.now()) {
        return { value: again.payload as T, fetchedAt: again.fetchedAt, stale: false };
      }
    }
    throw new BusyError(key);
  }
  try {
    const value = await fetcher();
    const t = deps.now();
    await deps.store.put(key, value, t, t + ttlMs);
    return { value, fetchedAt: t, stale: false };
  } catch (e) {
    if (hit) return { value: hit.payload as T, fetchedAt: hit.fetchedAt, stale: true };
    throw e;
  } finally {
    await deps.store.unlock(key);
  }
}

export function getSearch(deps: Deps, q: string): Promise<Cached<SearchHitDto[]>> {
  return getOrFetch(deps, `search:${q.toLowerCase()}`, TTL.search, () => deps.provider.search(q));
}

export function getChart(deps: Deps, symbol: string): Promise<Cached<ChartCompact>> {
  return getOrFetch(deps, `chart:${symbol}:v1`, TTL.chart, () => deps.provider.chart(symbol));
}

const toDto = (core: QuoteCore, fetchedAt: number, stale: boolean): QuoteDto => ({
  ...core,
  fetchedAt: new Date(fetchedAt).toISOString(),
  stale,
});

/**
 * Batched quotes with a constant number of store round trips (getMany, tryLockMany, putMany, unlockMany):
 * fresh hits, ONE provider call for the symbols we lock, stale values for locked ones.
 * `missing` = Yahoo does not know the symbol; `unavailable` = temporarily not obtainable (locked by
 * another request with nothing cached, or the provider failed with nothing cached).
 * Nothing servable and something unavailable: BusyError (503), or the provider error (502) if it failed.
 */
export async function getQuotes(
  deps: Deps,
  symbols: string[],
): Promise<{ quotes: QuoteDto[]; missing: string[]; unavailable: string[]; stale: boolean }> {
  const result = new Map<string, QuoteDto>();
  const missing = new Set<string>();
  const unavailable = new Set<string>();
  const staleHits = new Map<string, CacheEntry>();
  let acquired: string[] | null = null; // null until tryLockMany returned
  let attempted: string[] = [];
  let providerError: unknown = null;

  try {
    const hits = await deps.store.getMany(symbols.map((s) => `quote:${s}`));
    const now = deps.now();
    const candidates: string[] = [];
    for (const sym of symbols) {
      const hit = hits.get(`quote:${sym}`);
      if (hit && hit.expiresAt > now) {
        result.set(sym, toDto(hit.payload as QuoteCore, hit.fetchedAt, false));
        continue;
      }
      if (hit) staleHits.set(sym, hit);
      candidates.push(sym);
    }

    attempted = candidates.map((s) => `quote:${s}`);
    const got = await deps.store.tryLockMany(attempted, deps.now(), LOCK_TTL_MS);
    acquired = [...got];
    const toFetch: string[] = [];
    for (const sym of candidates) {
      const hit = staleHits.get(sym);
      if (got.has(`quote:${sym}`)) toFetch.push(sym);
      else if (hit) result.set(sym, toDto(hit.payload as QuoteCore, hit.fetchedAt, true));
      else unavailable.add(sym);
    }

    if (toFetch.length > 0) {
      try {
        const fetched = await deps.provider.quote(toFetch);
        const t = deps.now();
        try {
          await deps.store.putMany(
            fetched.map((core) => ({
              key: `quote:${core.symbol.toUpperCase()}`,
              payload: core,
              fetchedAt: t,
              expiresAt: t + TTL.quote,
            })),
          );
        } catch (e) {
          // The quotes are fresh; a cache write failure must not fail the request.
          logError("quote cache write failed", e);
        }
        for (const core of fetched) result.set(core.symbol.toUpperCase(), toDto(core, t, false));
        for (const sym of toFetch) if (!result.has(sym)) missing.add(sym); // unknown symbols are omitted by Yahoo
      } catch (e) {
        providerError = e;
        for (const sym of toFetch) {
          const hit = staleHits.get(sym);
          if (hit) result.set(sym, toDto(hit.payload as QuoteCore, hit.fetchedAt, true));
          else unavailable.add(sym);
        }
      }
    }
  } finally {
    // Release only locks we hold. Only if tryLockMany itself threw (acquired stays null) do we not know
    // which rows were taken and release all attempted keys.
    const toRelease = acquired ?? attempted;
    if (toRelease.length > 0) await deps.store.unlockMany(toRelease);
  }

  const quotes = symbols.flatMap((s) => (result.has(s) ? [result.get(s) as QuoteDto] : []));
  if (quotes.length === 0 && unavailable.size > 0) {
    if (providerError !== null) throw providerError;
    throw new BusyError("quote");
  }
  return {
    quotes,
    missing: symbols.filter((s) => missing.has(s)),
    unavailable: symbols.filter((s) => unavailable.has(s)),
    stale: quotes.some((q) => q.stale),
  };
}
