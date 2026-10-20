import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { NO_FILTERS, type TradeFilters } from "./trades-api";
import { tradesApi } from "./trades-default";

export function useTrades(page: number, filters: TradeFilters = NO_FILTERS) {
  return useQuery({
    queryKey: ["portfolio", "trades", page, filters],
    queryFn: () => tradesApi.page(page, filters),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/** The currencies offered by the filter bar; a failure just leaves the list at "All". */
export function useTradeCurrencies() {
  return useQuery({
    queryKey: ["portfolio", "trade-currencies"],
    queryFn: () => tradesApi.currencies(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
