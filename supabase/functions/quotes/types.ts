export interface SearchHitDto {
  symbol: string;
  exchange: string;
  quoteType: string;
  longName: string | null;
  shortName: string | null;
}
export interface QuoteCore {
  symbol: string;
  currency: string;
  exchange: string;
  fullExchangeName: string | null;
  longName: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null; // epoch ms
  regularMarketChangePercent: number | null;
  marketState: string | null;
}
export interface QuoteDto extends QuoteCore {
  fetchedAt: string; // ISO
  stale: boolean;
}
export interface ChartCompact {
  symbol: string;
  currency: string;
  exchange: string;
  exchangeTimezoneName: string | null;
  longName: string | null;
  bar_dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  regularMarketTime: number | null;
  marketState: string | null;
}
/** What the function needs from a market-data source; the real one wraps the P1 Yahoo adapter. */
export interface QuotesProvider {
  search(q: string): Promise<SearchHitDto[]>;
  quote(symbols: string[]): Promise<QuoteCore[]>;
  chart(symbol: string): Promise<ChartCompact>;
}
