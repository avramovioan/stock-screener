import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Clock, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { noteScanAccepted, queryKeys, useResearchQuota } from "@/features/screening/hooks";
import {
  type Requester,
  type ResearchRefusal,
  requestResearch,
} from "@/features/screening/research-request-api";
import type { DiscountRow } from "@/features/screening/types";
import { formatSofiaShort } from "@/lib/format";
import { relativeTime, useNow } from "@/lib/relative-time";
import { AiHandoff } from "./ai-handoff";
import {
  COOLDOWN_HOURS,
  isStale,
  pausedLine,
  RETRY_MINUTES,
  type ResearchView,
  researchView,
  waitLine,
} from "./research-state";

const MUTED = "text-[13px] text-muted-foreground";
const FLASH_MS = 2000;

/** Scans this page started or joined, by security id and click time: the card tells "finished after my click" from an older report. */
const bridged = new Map<string, number>();

/** Test hook: forget every scan this page started. */
export function clearBridgedScans(): void {
  bridged.clear();
}

/** What the browser knows from its own click until the feed catches up. */
type Outcome =
  | { kind: "started"; startedAt: string }
  | {
      kind: "refused";
      reason: ResearchRefusal;
      nextAllowedAt: string | null;
      /** An in_flight answer names the scan someone else started. */
      startedAt: string | null;
      requestedBy: Requester | null;
    };

type Display =
  | Exclude<ResearchView, { kind: "no_quota" }>
  | { kind: "no_quota"; resetAt: string | null }
  | { kind: "limits" }
  | { kind: "unreachable" }
  | { kind: "gone" };

/** The feed wins whenever it shows a scan or a fresh report; the click's outcome bridges the gap before that. */
function displayFor(
  view: ResearchView,
  outcome: Outcome | null,
  now: Date,
  quotaResetAt: string | null,
  quotaAvailable: boolean | undefined,
): Display {
  if (view.kind === "no_quota") {
    // A failure for lack of quota stands only while the quota is still gone (or not known yet).
    return quotaAvailable === true
      ? { kind: "not_scanned" }
      : { kind: "no_quota", resetAt: quotaResetAt };
  }
  if (
    !outcome ||
    view.kind === "running" ||
    view.kind === "paused" ||
    (view.kind === "done" && !view.canRescan)
  ) {
    return view;
  }
  if (outcome.kind === "started") {
    return {
      kind: "running",
      startedAt: outcome.startedAt,
      requestedBy: "visitor",
      waitReason: null,
    };
  }
  const until = outcome.nextAllowedAt ? new Date(outcome.nextAllowedAt).getTime() : null;
  switch (outcome.reason) {
    case "in_flight":
      return {
        kind: "running",
        startedAt: outcome.startedAt,
        requestedBy: outcome.requestedBy,
        waitReason: null,
      };
    case "cooldown":
      return {
        kind: "done",
        rescanAt: new Date(until ?? now.getTime() + COOLDOWN_HOURS * 3_600_000).toISOString(),
        canRescan: false,
      };
    case "no_quota":
    case "budget_paused":
      return { kind: "no_quota", resetAt: outcome.nextAllowedAt ?? quotaResetAt };
    case "retry_later":
      return {
        kind: "failed",
        retryInMinutes:
          until === null ? RETRY_MINUTES : Math.max(1, Math.ceil((until - now.getTime()) / 60_000)),
      };
    case "not_on_list":
      return { kind: "gone" };
    case "try_later":
      return { kind: "unreachable" };
    default:
      return { kind: "limits" };
  }
}

/** The cards that would offer Scan with AI; they show the no-quota block when the free quota is gone. */
function offersScan(display: Display): boolean {
  return (
    display.kind === "not_scanned" ||
    display.kind === "failed" ||
    display.kind === "busy" ||
    (display.kind === "done" && display.canRescan)
  );
}

function startedLine(view: Extract<ResearchView, { kind: "running" }>, now: Date): string {
  const who =
    view.requestedBy === "visitor"
      ? " by a visitor"
      : view.requestedBy === "owner"
        ? " by the owner"
        : view.requestedBy === "system"
          ? " by the daily scan"
          : "";
  const head = view.startedAt
    ? `Started ${relativeTime(view.startedAt, now)}${who}.`
    : "Waiting to start.";
  if (isStale(view.startedAt, now)) {
    return `${head} Taking longer than usual. An unfinished scan is retried after the daily reset.`;
  }
  return `${head} Usually a few minutes. This card updates by itself when it is done.`;
}

function ScanButton({
  label,
  disabled,
  starting = false,
  title,
  onClick,
}: {
  label: string;
  disabled: boolean;
  /** The request is on its way: a spinner replaces the sparkle and the button is busy. */
  starting?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || starting}
      aria-busy={starting || undefined}
      title={title}
      onClick={onClick}
      className="min-h-11 rounded-[10px] border-primary bg-card px-4 text-[15px] font-semibold text-primary hover:text-primary disabled:border-input disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
    >
      {starting ? (
        <span
          data-spinner
          aria-hidden="true"
          className="size-4 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin"
        />
      ) : disabled ? null : (
        <Sparkles aria-hidden="true" size={18} />
      )}
      {label}
    </Button>
  );
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">{title}</p>
      {children}
    </div>
  );
}

/**
 * The research part of every card (spec 5.1, boards ScanStates and Main): not scanned, running, done, failed or limits
 * reached, with Scan with AI and Copy the prompt. The feed decides the state; a refusal from the server is shown
 * until the feed catches up.
 */
export function ResearchPanel({ row, now }: { row: DiscountRow; now?: Date | undefined }) {
  useNow(); // keeps the minute re-render going
  const current = now ?? new Date();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const quota = useResearchQuota().data;
  const quotaResetAt = quota?.next_reset_at ?? null;
  const view = researchView(row, current);
  let display = displayFor(view, outcome, current, quotaResetAt, quota?.available);
  if (quota && !quota.available && offersScan(display)) {
    display = { kind: "no_quota", resetAt: quotaResetAt };
  }

  // Re-render at the moment a busy card may be retried, without waiting for the minute tick.
  const [, setBoundary] = useState(0);
  const retryAtMs = display.kind === "busy" ? Date.parse(display.retryAt) : null;
  useEffect(() => {
    if (retryAtMs === null) return;
    const left = retryAtMs - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => setBoundary((n) => n + 1), left + 50);
    return () => clearTimeout(id);
  }, [retryAtMs]);

  const feedSettled =
    view.kind === "running" || view.kind === "paused" || (view.kind === "done" && !view.canRescan);
  useEffect(() => {
    if (feedSettled) setOutcome(null);
  }, [feedSettled]);

  const scan = async () => {
    setBusy(true);
    const clickedAt = Date.now();
    const result = await requestResearch(row.security_id);
    if (result.ok || result.reason === "in_flight") {
      noteScanAccepted();
      bridged.set(row.security_id, clickedAt);
    }
    setOutcome(
      result.ok
        ? { kind: "started", startedAt: result.startedAt }
        : {
            kind: "refused",
            reason: result.reason,
            nextAllowedAt: result.nextAllowedAt,
            startedAt: result.startedAt ?? null,
            requestedBy: result.requestedBy ?? null,
          },
    );
    setBusy(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts }),
      queryClient.invalidateQueries({ queryKey: queryKeys.researchQuota }),
    ]);
  };

  let message: ReactNode = null;
  let action: ReactNode;
  const attribute: string = display.kind;
  switch (display.kind) {
    case "not_scanned":
      message = (
        <Message title="No AI research yet">
          <p className={MUTED}>
            Anyone can start one. Free, usually a few minutes. One scan per company every 72 hours.
          </p>
        </Message>
      );
      action = (
        <ScanButton
          label={busy ? "Starting…" : "Scan with AI"}
          disabled={false}
          starting={busy}
          onClick={() => void scan()}
        />
      );
      break;
    case "running": {
      const line = waitLine(display.waitReason);
      message = (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2.5 text-sm font-medium">
            <span
              data-pulse
              aria-hidden="true"
              className="scan-dot relative size-2.5 shrink-0 rounded-full bg-primary"
            />
            AI research running
          </p>
          <div
            role="progressbar"
            aria-label="AI research in progress"
            className="scan-bar relative h-1.5 overflow-hidden rounded-[3px] bg-muted"
          />
          <p className={MUTED}>{startedLine(display, current)}</p>
          {line ? <p className={MUTED}>{line}</p> : null}
        </div>
      );
      action = null;
      break;
    }
    case "paused":
      message = (
        <Message title="Research paused">
          <p className={MUTED}>{pausedLine(display.reason)}</p>
          <p className={MUTED}>
            {display.nextAttemptAt
              ? `Resumes ${formatSofiaShort(display.nextAttemptAt)}.`
              : "Resumes at the next scan."}
          </p>
        </Message>
      );
      action = null;
      break;
    case "busy": {
      const waiting = current.getTime() < Date.parse(display.retryAt);
      message = (
        <Message title="AI providers are busy">
          <p className={MUTED}>
            {waiting
              ? `Gemini was overloaded and the backups were at their limit. Try again after ${formatSofiaShort(display.retryAt)}.`
              : "Gemini was overloaded and the backups were at their limit. You can try again now."}
          </p>
        </Message>
      );
      action = (
        <ScanButton
          label={busy ? "Starting…" : "Try again with AI"}
          disabled={waiting}
          starting={busy}
          onClick={() => void scan()}
        />
      );
      break;
    }
    case "no_quota":
      message = (
        <Message title="No free AI quota left today">
          <p className={MUTED}>
            {display.resetAt
              ? `Run the evaluation in your own AI. Free quota returns ${formatSofiaShort(display.resetAt)}.`
              : "Run the evaluation in your own AI."}
          </p>
        </Message>
      );
      action = null;
      break;
    case "failed": {
      const waiting = display.retryInMinutes > 0;
      message = <Message title="The last scan failed" />;
      action = (
        <ScanButton
          label={
            busy
              ? "Starting…"
              : waiting
                ? `Try again in ${display.retryInMinutes} min`
                : "Scan with AI"
          }
          disabled={waiting}
          starting={busy}
          onClick={() => void scan()}
        />
      );
      break;
    }
    case "limits":
      message = (
        <Message title="Scans are paused for now">
          <p className={MUTED}>
            Either your network started several scans in the last hour, or today's free AI budget is
            used up. Try again later, or run the evaluation yourself with the prompt.
          </p>
        </Message>
      );
      action = <ScanButton label="Scan with AI" disabled />;
      break;
    case "unreachable":
      message = (
        <Message title="Couldn't start the scan right now">
          <p className={MUTED}>
            Something went wrong on our side. Please try again in a few minutes.
          </p>
        </Message>
      );
      action = (
        <ScanButton
          label={busy ? "Starting…" : "Try again"}
          disabled={false}
          starting={busy}
          onClick={() => void scan()}
        />
      );
      break;
    case "gone":
      message = <Message title="This company is no longer on the list" />;
      action = <ScanButton label="Scan with AI" disabled />;
      break;
    case "done":
      action = display.canRescan ? (
        <ScanButton
          label={busy ? "Starting…" : "Scan again with AI"}
          disabled={false}
          starting={busy}
          onClick={() => void scan()}
        />
      ) : (
        <span className="inline-flex min-h-11 items-center gap-2 text-[13px] text-muted-foreground">
          <Clock aria-hidden="true" size={16} />
          {`A new scan can be requested from ${formatSofiaShort(display.rescanAt)}`}
        </span>
      );
  }

  return (
    <div
      data-testid="research-panel"
      data-research={attribute}
      className="flex flex-col gap-2.5 border-t pt-3.5"
    >
      {message}
      {action}
      <AiHandoff row={row} />
    </div>
  );
}

/**
 * Tells the card that a scan this page saw in flight has just finished: true for 2 seconds, and one toast
 * "AI research for <ticker> is ready." with an Open report action. A card first seen finished never fires.
 */
export function useScanFinished(row: DiscountRow, ticker: string, now?: Date | undefined): boolean {
  const navigate = useNavigate();
  const kind = researchView(row, now ?? new Date()).kind;
  const sawRunning = useRef(false);
  const [flash, setFlash] = useState(false);
  const reportId = row.report_id;
  const securityId = row.security_id;
  const completedAt = row.research_completed_at;
  useEffect(() => {
    if (kind === "running") {
      sawRunning.current = true;
      return;
    }
    const clickedAt = bridged.get(securityId);
    const afterClick =
      clickedAt !== undefined && completedAt !== null && Date.parse(completedAt) >= clickedAt;
    if (kind !== "done" || !(sawRunning.current || afterClick)) {
      sawRunning.current = false;
      return;
    }
    sawRunning.current = false;
    bridged.delete(securityId);
    setFlash(true);
    toast.success(
      `AI research for ${ticker} is ready.`,
      reportId
        ? {
            action: {
              label: "Open report",
              onClick: () => void navigate({ to: "/research/$reportId", params: { reportId } }),
            },
          }
        : {},
    );
  }, [kind, ticker, reportId, securityId, completedAt, navigate]);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);
  return flash;
}
