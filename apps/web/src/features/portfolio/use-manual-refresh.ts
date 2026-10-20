import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { msUntil, serverOffsetMs } from "./cooldown";
import { portfolioApi } from "./default";
import { type ClientPortfolio, CooldownError } from "./portfolio-api";
import { PORTFOLIO_KEY } from "./use-portfolio";

export interface ManualRefresh {
  refresh(): Promise<void>;
  secondsLeft: number;
  available: boolean;
  refreshing: boolean;
  error: string | null;
  /** local timestamp of the last successful manual refresh (drives the polite announcement) */
  succeededAt: number | null;
}

/**
 * The manual refresh button / pull-to-refresh. The 60 s cooldown is shown from the SERVER's `manualAvailableAt` (corrected for clock
 * skew) and enforced again by the backend (HTTP 429). Clicks during the countdown or while a request runs are ignored. It subscribes
 * to the cached `["portfolio"]` data (no fetch of its own), so a manual result updates every component that shows the portfolio.
 */
export function useManualRefresh(): ManualRefresh {
  const queryClient = useQueryClient();
  const { data } = useQuery<ClientPortfolio>({
    queryKey: PORTFOLIO_KEY,
    queryFn: () => portfolioApi.get(),
    enabled: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [override, setOverride] = useState<number | null>(null); // local ms timestamp from a 429
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeededAt, setSucceededAt] = useState<number | null>(null);
  const busy = useRef(false);

  const offset = data === undefined ? 0 : serverOffsetMs(data.serverTime, data.receivedAtMs);
  const serverLeft = data === undefined ? 0 : msUntil(data.manualAvailableAt, now, offset);
  const overrideLeft = override === null ? 0 : Math.max(0, override - now);
  const leftMs = Math.max(serverLeft, overrideLeft);

  const cooling = leftMs > 0;
  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooling]);

  const refresh = useCallback(async () => {
    if (busy.current || leftMs > 0) return;
    busy.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await portfolioApi.refresh();
      const before = queryClient.getQueryData<ClientPortfolio>(PORTFOLIO_KEY);
      queryClient.setQueryData<ClientPortfolio>(PORTFOLIO_KEY, fresh);
      // a new statement day makes the statement history stale too
      if (before?.reportDate !== fresh.reportDate)
        void queryClient.invalidateQueries({ queryKey: ["analytics", "data"] });
      setSucceededAt(Date.now());
      setOverride(null);
    } catch (e) {
      if (e instanceof CooldownError) setOverride(Date.now() + e.retryAfterSeconds * 1000);
      else setError(e instanceof Error ? e.message : "The refresh failed.");
    } finally {
      busy.current = false;
      setRefreshing(false);
      setNow(Date.now());
    }
  }, [leftMs, queryClient]);

  return {
    refresh,
    secondsLeft: Math.ceil(leftMs / 1000),
    available: leftMs <= 0 && !refreshing,
    refreshing,
    error,
    succeededAt,
  };
}
