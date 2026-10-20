import { AUTO_REFRESH_MS } from "@core/statement-day.ts";
import { useQuery } from "@tanstack/react-query";
import { useVisibleInterval } from "../portfolio/use-visible-interval";
import { analyticsApi } from "./default";

export const ANALYTICS_KEY = ["analytics", "data"] as const;

/** Statement history (spec 14.2 key ["analytics", params]): refreshed every 5 minutes while the page is visible. */
export function useAnalyticsData(opts: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ANALYTICS_KEY,
    queryFn: () => analyticsApi.load(),
    enabled: opts.enabled,
    staleTime: AUTO_REFRESH_MS,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  useVisibleInterval(() => void query.refetch(), AUTO_REFRESH_MS, {
    enabled: opts.enabled,
    lastRunAt: () => (query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null),
  });
  return query;
}
