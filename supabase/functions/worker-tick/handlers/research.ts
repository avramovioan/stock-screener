import type { HandlerCtx, Job, ResearchDeps } from "../../_shared/adapters/research_types.ts";
import {
  type ChainPayload,
  failReportAfterDeadJob,
  parsePayload,
  runResearchStep,
  type StepOutcome,
  TRIGGER_PRIORITY,
} from "./research_steps.ts";

async function enqueueFollowUp(
  deps: ResearchDeps,
  job: Job,
  p: ChainPayload,
  outcome: StepOutcome,
): Promise<void> {
  if (outcome.kind === "done" || !outcome.reportId) return;
  const base: Record<string, unknown> = {
    security_id: p.security_id,
    trigger: p.trigger,
    scan_run_id: job.scan_run_id,
    scan_date_local: p.scan_date_local,
    report_id: outcome.reportId,
  };
  const priority = TRIGGER_PRIORITY[p.trigger];
  const id = outcome.reportId;
  if (p.late) base.late = true; // a side-channel chain stays a side-channel chain
  if (outcome.kind === "late") {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id,
      stage: "research",
      key: `research:${id}:${outcome.step}:late:${outcome.notBefore}`,
      payload: { ...base, step: outcome.step, n: p.n, late: true },
      priority,
      notBefore: outcome.notBefore,
    });
  } else if (outcome.kind === "next") {
    const suffix = outcome.suffix ? `:${outcome.suffix}` : "";
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id,
      stage: "research",
      key: `research:${id}:${outcome.step}${suffix}`,
      payload: { ...base, step: outcome.step },
      priority,
    });
  } else if (outcome.kind === "again") {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id,
      stage: "research",
      key: `research:${id}:${p.step}:${p.n + 1}`,
      payload: { ...base, step: p.step, n: p.n + 1 },
      priority,
      ...(outcome.notBefore ? { notBefore: outcome.notBefore } : {}),
    });
  } else {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id,
      stage: "research",
      key: `research:${id}:synthesize:r2`,
      payload: { ...base, step: "synthesize" },
      priority,
    });
  }
}

/** Handler of stage `research`: one bounded step per job, then the follow-up job (spec 9.10). */
export function researchHandler(deps: ResearchDeps) {
  return async (job: Job, ctx: HandlerCtx): Promise<unknown> => {
    if (job.payload.kind === "change_check") {
      if (!deps.changeCheck)
        throw new Error("change_check job received but no change-check handler is registered");
      return await deps.changeCheck(job, ctx);
    }
    const p = parsePayload(job.payload, job);
    let outcome: StepOutcome;
    try {
      outcome = await runResearchStep(deps, job, ctx, p);
    } catch (e) {
      // the last attempt (P1 max_attempts) must end the report: otherwise it stays `running` and its card pending forever
      const last =
        job.attempts !== undefined &&
        job.max_attempts !== undefined &&
        job.attempts >= job.max_attempts;
      const failed = last
        ? await failReportAfterDeadJob(deps, job, ctx, p, "job_failed").catch(() => null)
        : null;
      if (failed === null) throw e;
      return failed;
    }
    await enqueueFollowUp(deps, job, p, outcome);
    return outcome;
  };
}
