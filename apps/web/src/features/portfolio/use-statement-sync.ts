import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatSofiaClock } from "@/lib/format";
import { runActive } from "../broker/broker-view";
import { BROKER_KEY, useBrokerActions, useBrokerSnapshot } from "../broker/use-broker";

export interface StatementSync {
  start(): Promise<void>;
  /** a statement run is in progress (or the request that creates one) */
  active: boolean;
  /** local timestamp of the last run seen finishing from this page */
  syncedAt: number | null;
  /** local timestamp when the server's manual-sync cooldown ends, after a cooldown answer */
  nextAt: number | null;
  nextNotice: string | null;
  /** re-reads the run status now (the snapshot otherwise polls every 5 s while a run is active) */
  refreshSnapshot(): Promise<unknown>;
}

/**
 * The "Sync statement now" action: reuses the broker sync mutation and run polling. A run started here is watched until it ends:
 * `done` refetches holdings and trades, `failed`/`expired` toast once, and the server's 10-minute cooldown becomes a visible notice.
 */
export function useStatementSync(): StatementSync {
  const qc = useQueryClient();
  const snapshot = useBrokerSnapshot();
  const actions = useBrokerActions();
  const watched = useRef<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);

  const run = snapshot.data?.run ?? null;
  useEffect(() => {
    if (run === null) return;
    // any run seen in progress is watched, whoever started it (this page, the broker page, the daily job)
    if (runActive(run)) watched.current = run.id;
    if (run.id !== watched.current) return;
    if (run.state === "done") {
      watched.current = null;
      setSyncedAt(Date.now());
      setNextAt(null);
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
      void qc.invalidateQueries({ queryKey: ["holdingLinks"] });
    } else if (run.state === "failed" || run.state === "expired") {
      watched.current = null;
      toast.error(
        run.error_message ??
          (run.state === "expired"
            ? "The IBKR token has expired. Create a new one."
            : "The statement sync failed."),
      );
    }
  }, [run, qc]);

  useEffect(() => {
    if (nextAt === null) return;
    const timer = setTimeout(() => setNextAt(null), Math.max(0, nextAt - Date.now()));
    return () => clearTimeout(timer);
  }, [nextAt]);

  const { mutateAsync } = actions.sync;
  const start = useCallback(async () => {
    try {
      const result = await mutateAsync();
      if (result.ok) {
        watched.current = result.run?.id ?? null;
        return;
      }
      switch (result.kind) {
        case "cooldown": {
          const at = Date.now() + result.retryAfterSeconds * 1000;
          setNextAt(at);
          toast.info(`Statement synced recently; next at ${formatSofiaClock(at)}`);
          return;
        }
        case "busy":
          watched.current = snapshot.data?.run?.id ?? null;
          return;
        case "not_linked":
          toast.error("No broker is linked.");
          return;
        case "failed":
        case "invalid_input":
          toast.error(result.message);
          return;
      }
    } catch {
      toast.error("The statement sync failed. Try again.");
    }
  }, [mutateAsync, snapshot.data]);

  return {
    start,
    active: actions.sync.isPending || runActive(run),
    syncedAt,
    nextAt,
    nextNotice:
      nextAt === null ? null : `Statement synced recently; next at ${formatSofiaClock(nextAt)}`,
    refreshSnapshot: () => qc.invalidateQueries({ queryKey: BROKER_KEY }),
  };
}
