import type { DiscountRow } from "@/features/screening/types";

/** Spec 5.1 numbers: the per-company cooldown, the failed-scan retry and the report expiry. */
export const COOLDOWN_HOURS = 72;
export const RETRY_MINUTES = 60;
/** How long a card waits after "AI providers are busy" before a new scan is offered (research setting busy_retry_minutes). */
export const BUSY_RETRY_MINUTES = 15;
export const REPORT_EXPIRY_DAYS = 30;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A running scan older than this is called out as taking longer than usual. */
export const STALE_MINUTES = 90;

/** Wait reasons that park a report until a later attempt; rate_limited is a short retry and stays running. */
const PAUSED_LINES: Record<string, string> = {
  llm_quota: "Today's free AI budget is used up.",
  search_quota: "Today's free search budget is used up.",
  provider_unavailable: "The AI provider is unavailable right now.",
  weekend: "No AI work at the weekend.",
  cadence_72h: "Waiting for the 72-hour window.",
};

export type ResearchView =
  | { kind: "not_scanned" }
  | { kind: "paused"; reason: string; nextAttemptAt: string | null }
  | {
      kind: "running";
      startedAt: string | null;
      requestedBy: DiscountRow["research_requested_by"];
      waitReason: string | null;
    }
  | { kind: "done"; rescanAt: string; canRescan: boolean }
  | { kind: "busy"; retryAt: string }
  | { kind: "no_quota" }
  | { kind: "failed"; retryInMinutes: number };

/** The second line of a running card when the provider is rate limiting; null for any other reason. */
export function waitLine(reason: string | null): string | null {
  return reason === "rate_limited" ? "Provider busy, retrying" : null;
}

/** First line of a paused card; null when the reason does not pause a report. */
export function pausedLine(reason: string | null): string | null {
  return reason ? (PAUSED_LINES[reason] ?? null) : null;
}

/** True when a scan started more than 90 minutes ago. */
export function isStale(startedAt: string | null, now: Date): boolean {
  if (!startedAt) return false;
  return (now.getTime() - new Date(startedAt).getTime()) / MINUTE > STALE_MINUTES;
}

/** In flight means the feed found a queued, running or quota-deferred report; category_reason is a scan-time label and never counts. */
function inFlight(row: DiscountRow): boolean {
  // The newest result wins: a complete report at or after the in-flight start settles the card (the server ensures it too).
  if (row.research_completed_at && row.research_started_at) {
    if (Date.parse(row.research_completed_at) >= Date.parse(row.research_started_at)) return false;
  }
  return (
    row.research_started_at !== null ||
    row.research_wait_reason !== null ||
    row.research_requested_by !== null
  );
}

/** Where the research of a card stands, from the feed row alone (spec 5.1). */
export function researchView(row: DiscountRow, now: Date): ResearchView {
  if (inFlight(row)) {
    if (row.research_wait_reason && pausedLine(row.research_wait_reason)) {
      return {
        kind: "paused",
        reason: row.research_wait_reason,
        nextAttemptAt: row.next_attempt_at,
      };
    }
    return {
      kind: "running",
      startedAt: row.research_started_at,
      requestedBy: row.research_requested_by,
      waitReason: row.research_wait_reason,
    };
  }
  const completed = row.research_completed_at
    ? new Date(row.research_completed_at).getTime()
    : null;
  if (completed !== null && now.getTime() - completed < REPORT_EXPIRY_DAYS * 24 * HOUR) {
    const rescan = completed + COOLDOWN_HOURS * HOUR;
    return {
      kind: "done",
      rescanAt: new Date(rescan).toISOString(),
      canRescan: now.getTime() >= rescan,
    };
  }
  if (row.research_failed_at) {
    if (row.research_failed_reason === "providers_busy") {
      const retryAt = new Date(
        new Date(row.research_failed_at).getTime() + BUSY_RETRY_MINUTES * MINUTE,
      );
      return { kind: "busy", retryAt: retryAt.toISOString() };
    }
    if (row.research_failed_reason === "no_quota") return { kind: "no_quota" };
    const since = (now.getTime() - new Date(row.research_failed_at).getTime()) / MINUTE;
    return { kind: "failed", retryInMinutes: Math.max(0, Math.ceil(RETRY_MINUTES - since)) };
  }
  return { kind: "not_scanned" };
}
