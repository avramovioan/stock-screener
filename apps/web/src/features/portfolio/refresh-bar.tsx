import { AlertTriangle, RefreshCw } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatSessionDate, formatSofia, formatSofiaClock } from "@/lib/format";
import { formatCountdown, msUntil, serverOffsetMs } from "./cooldown";
import type { ClientPortfolio } from "./portfolio-api";
import { PullToRefresh } from "./pull-to-refresh";
import { type ManualRefresh, useManualRefresh } from "./use-manual-refresh";
import { useStatementSync } from "./use-statement-sync";

export interface RefreshBarProps {
  data: ClientPortfolio | undefined;
  /** error of the last background or manual fetch; `data` is still the last successful result */
  error: Error | null;
  fetching: boolean;
  children?: ReactNode;
}

const ManualContext = createContext<ManualRefresh | null>(null);

/**
 * Page-level container: a pull at the top of the page triggers the manual refresh (not only a pull on the status panel), and a
 * successful refresh is announced politely to screen readers. RefreshBar reads the same refresh state from here.
 */
export function RefreshablePage({
  enabled,
  children,
}: {
  /** false while there is no portfolio yet (loading, not linked, error): a pull does nothing */
  enabled: boolean;
  children: ReactNode;
}) {
  const manual = useManualRefresh();
  return (
    <ManualContext.Provider value={manual}>
      <PullToRefresh
        onRefresh={() => void manual.refresh()}
        disabled={!enabled || !manual.available}
      >
        {children}
      </PullToRefresh>
      <p role="status" aria-live="polite" className="sr-only" data-testid="refresh-announcement">
        {manual.succeededAt === null ? "" : `Data refreshed at ${formatSofia(manual.succeededAt)}.`}
      </p>
    </ManualContext.Provider>
  );
}

export function RefreshBar(props: RefreshBarProps) {
  const manual = useContext(ManualContext);
  if (manual === null)
    return (
      <RefreshablePage enabled={props.data !== undefined}>
        <RefreshBarBody {...props} />
      </RefreshablePage>
    );
  return <RefreshBarBody {...props} />;
}

function RefreshBarBody({ data, error, fetching, children }: RefreshBarProps) {
  const manual = useContext(ManualContext) as ManualRefresh;
  const statement = useStatementSync();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const offset = data === undefined ? 0 : serverOffsetMs(data.serverTime, data.receivedAtMs);
  const nextMs = data === undefined ? 0 : msUntil(data.nextAutoRefreshAt, now, offset);
  const last = data?.lastSuccessfulAt ?? null;
  const behind = data?.statement.freshness.kind === "behind" ? data.statement.freshness.days : null;
  const quotesLive = data?.quoteError ? false : last !== null;
  const reportDay = data?.reportDate ? formatSessionDate(data.reportDate) : null;
  const statusLine =
    reportDay === null
      ? "No statement yet"
      : `Positions from the IBKR statement of ${reportDay} · Prices: ${
          quotesLive
            ? `delayed quotes as of ${formatSofia(last)} (15–20 min)`
            : `statement close of ${reportDay}`
        }`;
  const problems = [
    error === null
      ? null
      : `Could not refresh: ${error.message}${last === null ? "" : ` Showing the data from ${formatSofia(last)}.`}`,
    data?.quoteError
      ? "Delayed quotes are unavailable right now; values use the statement close of the report date."
      : null,
    manual.error,
  ].filter((p): p is string => p !== null);

  return (
    <>
      <section aria-label="Refresh status" className="space-y-2 rounded-md border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{statusLine}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              disabled={!manual.available}
              onClick={() => void manual.refresh()}
            >
              <RefreshCw
                aria-hidden="true"
                className={
                  manual.refreshing || fetching ? "animate-spin motion-reduce:animate-none" : ""
                }
                size={14}
              />
              {manual.secondsLeft > 0
                ? `Refresh quotes in ${formatCountdown(manual.secondsLeft * 1000)}`
                : "Refresh quotes"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              disabled={statement.active}
              title={statement.nextNotice ?? undefined}
              onClick={() => void statement.start()}
            >
              <RefreshCw
                aria-hidden="true"
                className={statement.active ? "animate-spin motion-reduce:animate-none" : ""}
                size={14}
              />
              {statement.active ? "Syncing statement…" : "Sync statement now"}
            </Button>
          </div>
        </div>
        {behind !== null ? (
          <p className="inline-flex items-center gap-1 rounded border border-[var(--status-amber-bd)] px-2 py-0.5">
            <AlertTriangle aria-hidden="true" size={14} />
            {`The statement is ${behind} day${behind === 1 ? "" : "s"} behind the expected date${data?.syncQueued ? "; a sync was requested" : ""}.`}
          </p>
        ) : null}
        <p className="text-muted-foreground">
          IBKR produces statements once a day after the close; today's trades appear in tomorrow's
          statement.
        </p>
        <p
          role="status"
          aria-live="polite"
          className="sr-only"
          data-testid="statement-announcement"
        >
          {statement.syncedAt === null
            ? ""
            : `Statement synced at ${formatSofiaClock(statement.syncedAt)}.`}
        </p>
        <p className="text-muted-foreground">
          {`Last successful refresh: ${last === null ? "none yet" : formatSofia(last)}`}
          {" · "}
          {document.visibilityState === "hidden"
            ? "automatic refresh paused while the tab is hidden"
            : `Next automatic refresh in ${formatCountdown(nextMs)}`}
        </p>
        {problems.map((p) => (
          <p
            key={p}
            role="alert"
            className="rounded border border-[var(--status-red-bd)] px-2 py-1"
          >
            {p}
          </p>
        ))}
        {children}
      </section>
    </>
  );
}
