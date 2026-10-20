import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { researchView } from "@/features/overview/research-state";
import {
  fetchCompanyList,
  fetchPriceSeries,
  fetchResearchQuota,
  fetchScanStatus,
  fetchShortSummary,
  fetchTodaysDiscounts,
} from "./api";
import { nextAfterRank, PAGE_FIRST, PAGE_NEXT } from "./page-merge";
import type { DiscountRow } from "./types";

export const STALE_MS = 60_000;
export const POLL_MS = 5 * 60_000;
/** While a scan is running (or was just accepted on this page) the feed is checked this often. */
export const LIVE_POLL_MS = 15_000;
const ACCEPTED_WINDOW_MS = 2 * 60_000;
export const STATUS_POLL_MS = 60_000;
export const CHART_STALE_MS = 10 * 60_000;
export const CHART_GC_MS = 30 * 60_000;

export const queryKeys = {
  scanStatus: ["scanStatus"] as const,
  discounts: ["discounts"] as const,
  researchQuota: ["researchQuota"] as const,
  companyList: (country: string | null) => ["companyList", country ?? "all"] as const,
  shortSummary: ["shortSummary"] as const,
  chart: (securityId: string) => ["chart", securityId] as const,
};

/** Polling only while the tab is visible (refetchIntervalInBackground is false). */
const visiblePoll = {
  staleTime: STALE_MS,
  refetchInterval: POLL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: false,
} as const;

let lastAcceptedAt = 0;

/** Remember that Scan with AI was accepted on this page, so the feed polls fast for the next 2 minutes. */
export function noteScanAccepted(at: number = Date.now()): void {
  lastAcceptedAt = at;
}

function discountsInterval(query: { state: { data: DiscountRow[] | undefined } }): number {
  if (Date.now() - lastAcceptedAt < ACCEPTED_WINDOW_MS) return LIVE_POLL_MS;
  const now = new Date();
  const running = (query.state.data ?? []).some((row) => researchView(row, now).kind === "running");
  return running ? LIVE_POLL_MS : POLL_MS;
}

export function useScanStatus() {
  return useQuery({
    queryKey: queryKeys.scanStatus,
    queryFn: fetchScanStatus,
    staleTime: STALE_MS,
    refetchInterval: STATUS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useTodaysDiscounts() {
  return useQuery({
    queryKey: queryKeys.discounts,
    queryFn: () => fetchTodaysDiscounts(),
    ...visiblePoll,
    refetchInterval: discountsInterval,
  });
}

/** Whether a new AI scan can run now; fetched once per page view and refetched with the feed. */
export function useResearchQuota() {
  return useQuery({
    queryKey: queryKeys.researchQuota,
    queryFn: () => fetchResearchQuota(),
    ...visiblePoll,
  });
}

/** The ranked list; `country` is the exact country name the database filters on (null = every country). */
export function useCompanyList(country: string | null = null) {
  return useInfiniteQuery({
    queryKey: queryKeys.companyList(country),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      fetchCompanyList(pageParam, pageParam === null ? PAGE_FIRST : PAGE_NEXT, country),
    getNextPageParam: (lastPage) => nextAfterRank(lastPage),
    ...visiblePoll,
  });
}

export function useShortSummary() {
  return useQuery({
    queryKey: queryKeys.shortSummary,
    queryFn: () => fetchShortSummary(),
    ...visiblePoll,
  });
}

export function usePriceSeries(securityId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.chart(securityId ?? "none"),
    queryFn: () => fetchPriceSeries(securityId as string),
    enabled: securityId !== undefined,
    staleTime: CHART_STALE_MS,
    gcTime: CHART_GC_MS,
    refetchOnWindowFocus: false,
  });
}
