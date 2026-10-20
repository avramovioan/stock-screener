import type { ResearchStore } from "../../_shared/adapters/research_types.ts";
import { TRIGGER_PRIORITY } from "../../worker-tick/handlers/research_steps.ts";

export type ResearchNowResult =
  | {
      ok: true;
      job_key: string;
      scan_run_id: string;
      scan_date_local: string;
      existing_report_id: string | null;
    }
  | { ok: false; error: "invalid_input" | "unknown_security" | "no_scan_run" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Operator request (spec 7.12): queue a `manual` full report for one security in the latest scan run.
 * Idempotent per Sofia day: a second call returns the existing report unless it failed (`force` re-queues a failed one).
 * P1 check: `claim_jobs` must claim research jobs of the latest run even after it finished; if it only claims running
 * runs, call `refresh_scan_status` for the run first.
 */
export async function researchNow(
  deps: {
    store: Pick<ResearchStore, "loadSecurity" | "latestScanRun" | "enqueueJob" | "findReportByKey">;
  },
  input: { security_id?: unknown; force?: unknown },
): Promise<ResearchNowResult> {
  const securityId = typeof input.security_id === "string" ? input.security_id : "";
  if (!ID.test(securityId)) return { ok: false, error: "invalid_input" };
  if (!(await deps.store.loadSecurity(securityId))) return { ok: false, error: "unknown_security" };
  const run = await deps.store.latestScanRun();
  if (!run) return { ok: false, error: "no_scan_run" };
  const existing = await deps.store.findReportByKey(`${securityId}:manual:${run.scanDateLocal}`);
  const force = input.force === true;
  if (existing && !(existing.status === "failed" && force)) {
    return {
      ok: true,
      job_key: "",
      scan_run_id: run.id,
      scan_date_local: run.scanDateLocal,
      existing_report_id: existing.id,
    };
  }
  const key = `research:${securityId}:manual:plan${existing ? `:${Date.now()}` : ""}`;
  await deps.store.enqueueJob({
    scanRunId: run.id,
    stage: "research",
    key,
    priority: 5,
    payload: {
      security_id: securityId,
      trigger: "manual",
      scan_date_local: run.scanDateLocal,
      force,
    },
  });
  return {
    ok: true,
    job_key: key,
    scan_run_id: run.id,
    scan_date_local: run.scanDateLocal,
    existing_report_id: existing?.id ?? null,
  };
}

export type VisitorResearchResult =
  | {
      ok: true;
      /** The queued report created together with the job (it exists from this moment). */
      report_id: string;
      job_key: string;
      scan_run_id: string;
      started_at: string;
    }
  | {
      ok: false;
      error: "in_flight";
      /** The scan already queued or running for this security: its start (or queue) time and who asked. */
      started_at: string | null;
      requested_by: "visitor" | "owner" | "system" | null;
    }
  | { ok: false; error: "invalid_input" | "no_scan_run" };

/**
 * Visitor request (spec 5.1): queue a `visitor` full report for one security in the latest PUBLISHED run. It performs no policy
 * check (list membership, cooldown, limits); the `research-request` function does. The report row (status `queued`) and the job
 * are created in one atomic step that refuses a second scan of the same security while one is queued or running. The request
 * key carries the accepted minute, so a failed earlier report never blocks the next request.
 */
export async function requestVisitorResearch(
  deps: {
    store: Pick<ResearchStore, "latestPublishedRun" | "acceptVisitorResearch">;
    now: () => Date;
  },
  input: { security_id: string },
): Promise<VisitorResearchResult> {
  const securityId = input.security_id;
  if (!ID.test(securityId)) return { ok: false, error: "invalid_input" };
  const run = await deps.store.latestPublishedRun();
  if (!run) return { ok: false, error: "no_scan_run" };
  const accepted = deps.now();
  const acceptedAt = new Date(Math.floor(accepted.getTime() / 60_000) * 60_000).toISOString();
  const key = `research:${securityId}:visitor:plan:${acceptedAt}`;
  const res = await deps.store.acceptVisitorResearch({
    securityId,
    scanRunId: run.id,
    acceptedAt: accepted.toISOString(),
    reportKey: `${securityId}:visitor:${acceptedAt}`,
    job: {
      stage: "research",
      key,
      priority: TRIGGER_PRIORITY.visitor,
      payload: {
        security_id: securityId,
        trigger: "visitor",
        scan_date_local: run.scanDateLocal,
        accepted_at: acceptedAt,
        source: "visitor",
      },
    },
  });
  if (!res.accepted) {
    return {
      ok: false,
      error: "in_flight",
      started_at: res.startedAt,
      requested_by: res.requestedBy,
    };
  }
  return {
    ok: true,
    report_id: res.reportId,
    job_key: key,
    scan_run_id: run.id,
    started_at: res.startedAt,
  };
}
