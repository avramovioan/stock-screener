import { useQuery } from "@tanstack/react-query";
import { CHART_GC_MS, CHART_STALE_MS, POLL_MS } from "./hooks";
import { fetchChartBySymbol, fetchQuotes, fetchQuotesDetailed, searchSymbols } from "./quotes-api";

export const quotesKeys = {
  quotes: (sortedSymbols: readonly string[]) => ["quotes", sortedSymbols] as const,
  quotesDetailed: (sortedSymbols: readonly string[]) => ["quotesDetailed", sortedSymbols] as const,
  chartSymbol: (symbol: string) => ["chartSymbol", symbol] as const,
  search: (q: string) => ["search", q] as const,
};

/** Delayed quotes for visible rows and EUR lines; polls every 5 min while visible. */
export function useQuotes(symbols: readonly string[]) {
  const sorted = [...new Set(symbols)].sort();
  return useQuery({
    queryKey: quotesKeys.quotes(sorted),
    queryFn: () => fetchQuotes(sorted),
    enabled: sorted.length > 0,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
}

/** Like useQuotes but keeps `missing` and `unavailable` so the UI can tell "unknown" from "retry". */
export function useQuotesDetailed(symbols: readonly string[]) {
  const sorted = [...new Set(symbols)].sort();
  return useQuery({
    queryKey: quotesKeys.quotesDetailed(sorted),
    queryFn: () => fetchQuotesDetailed(sorted),
    enabled: sorted.length > 0,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
}

export function useChartBySymbol(symbol: string | undefined) {
  return useQuery({
    queryKey: quotesKeys.chartSymbol(symbol ?? "none"),
    queryFn: () => fetchChartBySymbol(symbol as string),
    enabled: symbol !== undefined,
    staleTime: CHART_STALE_MS,
    gcTime: CHART_GC_MS,
    refetchOnWindowFocus: false,
  });
}

/** Minimum 2 characters; the caller debounces by 300 ms. */
export function useSymbolSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: quotesKeys.search(term.toLowerCase()),
    queryFn: () => searchSymbols(term),
    enabled: term.length >= 2,
    staleTime: 60 * 60_000,
    refetchOnWindowFocus: false,
  });
}
