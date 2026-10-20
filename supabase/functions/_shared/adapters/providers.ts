// supabase/functions/_shared/adapters/providers.ts  (Deno side; core never imports it)
// Spec 5.1 verbatim. Every record handed back by an adapter carries its provider through the owning interface (`id`).
import type { RawBar } from "../core/bars.ts";

export interface QuoteRecord {
  symbol: string;
  quoteType: string; // EQUITY | ETF | FUTURE | ...
  currency: string;
  financialCurrency: string | null; // trading currency (may be GBp/ZAc/ILA/KWF); reporting currency
  exchange: string;
  fullExchangeName: string | null; // NMS, NYQ, GER ...
  longName: string | null;
  shortName: string | null;
  marketCap: number | null; // MAJOR currency unit (spike 3.3)
  sharesOutstanding: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null; // epoch ms
  regularMarketPreviousClose: number | null;
  regularMarketChangePercent: number | null;
  marketState: string | null; // REGULAR | PRE | PREPRE | POST | POSTPOST | CLOSED
  firstTradeDateMs: number | null;
  exchangeTimezoneName: string | null;
  priceHint: number | null;
  averageDailyVolume3Month?: number | null; // present in the recorded quote and screener samples (P1-06)
}
export interface ChartRequest {
  period1: string;
  period2?: string;
  interval: "1d";
  events: "split" | "div|split";
}
export interface SplitEvent {
  dateMs: number;
  numerator: number;
  denominator: number;
}
export interface ChartResult {
  meta: {
    currency: string;
    exchange: string;
    exchangeTimezoneName: string;
    firstTradeDateMs: number | null;
    regularMarketTime: number | null;
    currentTradingPeriod: { start: number; end: number } | null;
    instrumentType: string | null;
    longName: string | null;
  };
  bars: RawBar[]; // core RawBar; OHLC split-adjusted, NOT dividend-adjusted
  splits: SplitEvent[];
}
export interface CompanyProfile {
  symbol: string;
  country: string | null;
  sector: string | null;
  industry: string | null;
  summary: string | null;
  employees: number | null;
}
export interface NewsItem {
  id: string;
  title: string;
  publisher: string | null;
  url: string;
  publishedMs: number;
  relatedTickers: string[];
}
export interface SearchHit {
  symbol: string;
  exchange: string;
  quoteType: string;
  longName: string | null;
  shortName: string | null;
  sector: string | null;
  industry: string | null;
}
export interface ScreenerRow extends QuoteRecord {} // quote-family fields; no sector/industry/country/ISIN/ADR flag (spike 3.7)
export interface ScreenerPage {
  total: number;
  offset: number;
  count: number;
  rows: ScreenerRow[];
}

export interface MarketDataProvider {
  readonly id: string; // "yahoo"
  search(
    q: string,
    o?: { quotesCount?: number; newsCount?: number },
  ): Promise<{ hits: SearchHit[]; news: NewsItem[] }>;
  quote(symbols: string[], o?: { fields?: string[] }): Promise<QuoteRecord[]>; // unknown symbols are OMITTED, never errors (spike 3.3)
  chart(symbol: string, req: ChartRequest): Promise<ChartResult>;
  profile(symbol: string): Promise<CompanyProfile>; // quoteSummary assetProfile + quoteType
  news(symbol: string, count: number): Promise<NewsItem[]>;
  screen(req: {
    exchange: string;
    minMarketCapLocal: number;
    offset: number;
    size: number;
  }): Promise<ScreenerPage>;
}
export interface FxQuote {
  ccy: string;
  usdPerUnit: number;
  rateDate: string;
  source: "frankfurter" | "yahoo";
  sourceSymbol: string | null;
}
export interface FxProvider {
  readonly id: string;
  usdPerUnit(ccys: string[]): Promise<{ rates: FxQuote[]; missing: string[] }>;
}
