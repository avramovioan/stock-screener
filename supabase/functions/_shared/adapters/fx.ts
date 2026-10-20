import { resolveCurrency } from "../core/units.ts";
import type { Clock } from "./clock.ts";
import type { FxProvider, FxQuote, QuoteRecord } from "./providers.ts";
import type { FetchLike } from "./throttle.ts";

/**
 * FX adapter (5.4). Primary: Frankfurter, GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY,...
 * (verified 2026-10-15: response {amount, base, date, rates}; 30 currencies; unsupported symbols are silently omitted;
 * a request whose symbols are ALL unsupported returns HTTP 404 {"message":"not found"}).
 * The response is units of currency per USD; usdPerUnit = 1 / rate. Fallback: Yahoo "<CCY>USD=X" regularMarketPrice.
 */
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
export const FX_SANE_MAX = 1e6;
export const FX_DISAGREEMENT_TOLERANCE = 0.02;

export interface FxProviderOptions {
  fetchImpl: FetchLike;
  clock: Clock;
  /** Yahoo quote() of the fallback symbols (the yahoo provider's quote). Without it, missing currencies stay missing. */
  quote?: (symbols: string[]) => Promise<QuoteRecord[]>;
  /** Currencies that Frankfurter returned and that are cross-checked against Yahoo (default EUR). */
  crossCheck?: string[];
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

const sane = (usdPerUnit: number): boolean =>
  Number.isFinite(usdPerUnit) && usdPerUnit > 0 && usdPerUnit < FX_SANE_MAX;
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function fxRowFor(
  ccy: string,
  fx: FxQuote,
): {
  ccy: string;
  usd_per_unit: number;
  rate_date: string;
  source: string;
  source_symbol: string | null;
} {
  return {
    ccy,
    usd_per_unit: fx.usdPerUnit,
    rate_date: fx.rateDate,
    source: fx.source,
    source_symbol: fx.sourceSymbol,
  };
}

export function createFxProvider(o: FxProviderOptions): FxProvider {
  const emit = o.onEvent ?? (() => undefined);
  const crossCheck = o.crossCheck ?? ["EUR"];

  async function frankfurter(
    ccys: string[],
  ): Promise<{ date: string | null; usd: Map<string, number> }> {
    const usd = new Map<string, number>();
    if (ccys.length === 0) return { date: null, usd };
    let res: Response;
    try {
      res = await o.fetchImpl(`${FRANKFURTER_URL}?base=USD&symbols=${ccys.join(",")}`, {
        headers: { Accept: "application/json" },
      });
    } catch (e) {
      emit("fx_frankfurter_failed", { reason: e instanceof Error ? e.message : "network" });
      return { date: null, usd };
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return { date: null, usd }; // every requested symbol is unsupported
    }
    if (!res.ok) {
      await res.body?.cancel();
      emit("fx_frankfurter_failed", { status: res.status });
      return { date: null, usd };
    }
    const body = (await res.json()) as { date?: unknown; rates?: Record<string, unknown> };
    const date = typeof body.date === "string" ? body.date : null;
    for (const [ccy, rate] of Object.entries(body.rates ?? {})) {
      if (typeof rate !== "number" || !(rate > 0)) continue;
      const perUnit = 1 / rate;
      if (sane(perUnit)) usd.set(ccy, perUnit);
    }
    return { date, usd };
  }

  return {
    id: "frankfurter+yahoo",

    async usdPerUnit(ccys) {
      const wanted = [...new Set(ccys.map((c) => resolveCurrency(c).major))].sort();
      const rates: FxQuote[] = [];
      const needsRate = wanted.filter((c) => c !== "USD");

      const { date, usd } = await frankfurter(needsRate);
      const today = utcDate(o.clock.now());
      if (wanted.includes("USD"))
        rates.push({
          ccy: "USD",
          usdPerUnit: 1,
          rateDate: date ?? today,
          source: "frankfurter",
          sourceSymbol: null,
        });
      for (const ccy of needsRate) {
        const v = usd.get(ccy);
        if (v !== undefined && date !== null)
          rates.push({
            ccy,
            usdPerUnit: v,
            rateDate: date,
            source: "frankfurter",
            sourceSymbol: null,
          });
      }

      const missingAfterFrankfurter = needsRate.filter((c) => !rates.some((r) => r.ccy === c));
      const checks =
        o.quote === undefined
          ? []
          : crossCheck.filter((c) => rates.some((r) => r.ccy === c && r.source === "frankfurter"));
      const symbols = [...new Set([...missingAfterFrankfurter, ...checks].map((c) => `${c}USD=X`))];
      const yahoo = new Map<string, QuoteRecord>();
      if (o.quote !== undefined && symbols.length > 0) {
        try {
          for (const q of await o.quote(symbols)) yahoo.set(q.symbol, q);
        } catch (e) {
          emit("fx_yahoo_failed", { reason: e instanceof Error ? e.message : "error" });
        }
      }

      const missing: string[] = [];
      for (const ccy of missingAfterFrankfurter) {
        const q = yahoo.get(`${ccy}USD=X`);
        const price = q?.regularMarketPrice ?? null;
        if (q !== undefined && price !== null && sane(price)) {
          rates.push({
            ccy,
            usdPerUnit: price,
            rateDate: q.regularMarketTime !== null ? utcDate(q.regularMarketTime) : today,
            source: "yahoo",
            sourceSymbol: q.symbol,
          });
        } else {
          missing.push(ccy);
        }
      }

      for (const ccy of checks) {
        const f = rates.find((r) => r.ccy === ccy && r.source === "frankfurter");
        const y = yahoo.get(`${ccy}USD=X`)?.regularMarketPrice ?? null;
        if (f !== undefined && y !== null && sane(y)) {
          const rel = Math.abs(f.usdPerUnit - y) / f.usdPerUnit;
          if (rel > FX_DISAGREEMENT_TOLERANCE)
            emit("fx_source_disagreement", {
              ccy,
              frankfurter: f.usdPerUnit,
              yahoo: y,
              relDiff: rel,
            });
        }
      }

      rates.sort((a, b) => (a.ccy < b.ccy ? -1 : a.ccy > b.ccy ? 1 : 0));
      return { rates, missing };
    },
  };
}
