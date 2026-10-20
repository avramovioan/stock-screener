import { systemClock } from "@adapters/clock.ts";
import { createQuoteCacheKv } from "@adapters/db.ts";
import type { MarketDataProvider } from "@adapters/providers.ts";
import { createYahooEnabledCheck } from "@adapters/settings.ts";
import { createYahooProvider } from "@adapters/yahoo.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type BarLike, toCompactBars } from "./compact.ts";
import type { QuotesProvider } from "./types.ts";

const THIRTEEN_YEARS_MS = 13 * 365.25 * 86_400_000;

export function fromMarketData(md: MarketDataProvider, nowMs: () => number): QuotesProvider {
  return {
    async search(q) {
      const { hits } = await md.search(q, { quotesCount: 15, newsCount: 0 });
      return hits
        .filter((h) => h.quoteType === "EQUITY" || h.quoteType === "ETF")
        .slice(0, 15)
        .map((h) => ({
          symbol: h.symbol,
          exchange: h.exchange,
          quoteType: h.quoteType,
          longName: h.longName,
          shortName: h.shortName,
        }));
    },
    async quote(symbols) {
      const rows = await md.quote(symbols);
      return rows.map((r) => ({
        symbol: r.symbol,
        currency: r.currency,
        exchange: r.exchange,
        fullExchangeName: r.fullExchangeName,
        longName: r.longName ?? r.shortName,
        regularMarketPrice: r.regularMarketPrice,
        regularMarketTime: r.regularMarketTime,
        regularMarketChangePercent: r.regularMarketChangePercent,
        marketState: r.marketState,
      }));
    },
    async chart(symbol) {
      const period1 = new Date(nowMs() - THIRTEEN_YEARS_MS).toISOString().slice(0, 10);
      const [result, quotes] = await Promise.all([
        md.chart(symbol, { period1, interval: "1d", events: "split" }),
        md.quote([symbol]),
      ]);
      const marketState = quotes[0]?.marketState ?? null;
      const bars: BarLike[] = result.bars.map((b) => ({
        dateMs: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));
      return {
        symbol,
        currency: result.meta.currency,
        exchange: result.meta.exchange,
        exchangeTimezoneName: result.meta.exchangeTimezoneName,
        longName: result.meta.longName,
        ...toCompactBars(bars, marketState, result.meta.exchangeTimezoneName),
        regularMarketTime: result.meta.regularMarketTime,
        marketState,
      };
    },
  };
}

export function createProvider(db: SupabaseClient): QuotesProvider {
  const md = createYahooProvider({
    fetchImpl: fetch,
    store: createQuoteCacheKv(db),
    clock: systemClock,
    isEnabled: createYahooEnabledCheck(
      async () =>
        (await db.from("app_settings").select("value").eq("key", "providers").maybeSingle()).data
          ?.value,
      Date.now,
    ),
  });
  return fromMarketData(md, Date.now);
}
