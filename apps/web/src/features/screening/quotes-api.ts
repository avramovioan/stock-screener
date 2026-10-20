import { toApiError } from "./errors";

export interface SearchHit {
  symbol: string;
  exchange: string;
  quoteType: string;
  longName: string | null;
  shortName: string | null;
}
export interface QuoteDto {
  symbol: string;
  currency: string;
  exchange: string;
  fullExchangeName: string | null;
  longName: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null; // epoch ms
  regularMarketChangePercent: number | null;
  marketState: string | null;
  fetchedAt: string; // ISO
  stale: boolean;
}
export interface ChartDto {
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
  fetchedAt: string;
  stale: boolean;
}

function base(): string {
  const url = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
  return `${url}/functions/v1/quotes`;
}
function headers(): HeadersInit {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
  // The anon key is public by design; Kong may require the bearer next to apikey.
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { ...init, headers: headers() });
  } catch (e) {
    throw toApiError({ status: 0, message: e instanceof Error ? e.message : String(e) });
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* body was not JSON */
    }
    throw toApiError({ status: res.status, message });
  }
  return (await res.json()) as T;
}

export async function searchSymbols(q: string): Promise<SearchHit[]> {
  const out = await call<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`);
  return out.hits;
}
export interface QuotesResult {
  quotes: QuoteDto[];
  /** Symbols Yahoo does not know. */
  missing: string[];
  /** Symbols that could not be served right now (locked or provider failure, nothing cached): retry, never "unknown". */
  unavailable: string[];
  fetchedAt: string;
  /** True when any served quote is stale. */
  stale: boolean;
}

const EMPTY_QUOTES: QuotesResult = {
  quotes: [],
  missing: [],
  unavailable: [],
  fetchedAt: "",
  stale: false,
};

/** Full `/quote` response. 503 (busy) and 502 (upstream) arrive as thrown ApiErrors; partial results are 200. */
export async function fetchQuotesDetailed(symbols: readonly string[]): Promise<QuotesResult> {
  if (symbols.length === 0) return EMPTY_QUOTES;
  const out = await call<Partial<QuotesResult> & { quotes: QuoteDto[] }>("/quote", {
    method: "POST",
    body: JSON.stringify({ symbols }),
  });
  return {
    ...EMPTY_QUOTES,
    ...out,
    missing: out.missing ?? [],
    unavailable: out.unavailable ?? [],
  };
}
export async function fetchQuotes(symbols: readonly string[]): Promise<QuoteDto[]> {
  return (await fetchQuotesDetailed(symbols)).quotes;
}
export function fetchChartBySymbol(symbol: string): Promise<ChartDto> {
  return call<ChartDto>(`/chart?symbol=${encodeURIComponent(symbol)}`);
}
