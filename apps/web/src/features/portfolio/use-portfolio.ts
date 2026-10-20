import { AUTO_REFRESH_MS } from "@core/statement-day.ts";
import { useQuery } from "@tanstack/react-query";
import { portfolioApi } from "./default";
import { NotLinkedError } from "./portfolio-api";
import { useVisibleInterval } from "./use-visible-interval";

export const PORTFOLIO_KEY = ["portfolio"] as const;

/**
 * Valued positions (spec 14.2 key ["portfolio"]). Auto refresh every 5 minutes only while the page is visible; an auto refresh never
 * calls Flex. A failed refetch keeps `data` (TanStack Query semantics) so the UI shows the last successful figures plus the error.
 */
export function usePortfolio(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const query = useQuery({
    queryKey: PORTFOLIO_KEY,
    queryFn: () => portfolioApi.get(),
    enabled,
    staleTime: 0,
    retry: (failureCount, error) => !(error instanceof NotLinkedError) && failureCount < 1,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
  useVisibleInterval(() => void query.refetch(), AUTO_REFRESH_MS, {
    enabled,
    lastRunAt: () => (query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null),
  });
  return query;
}
