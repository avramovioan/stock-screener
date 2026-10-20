import type { Db, ScanJob } from "../_shared/adapters/db.ts";
import type { JobStage, ScanEventRow } from "../_shared/adapters/log.ts";
import { scanEvent } from "../_shared/adapters/log.ts";
import { type PipelineSettings, SettingsError } from "../_shared/adapters/settings.ts";
import { BudgetExceededError, YahooUnavailableError } from "../_shared/adapters/throttle.ts";
import { assertSignalGradeSettings } from "../_shared/core/indicator.ts";
import {
  DeferError,
  type EventExtra,
  FatalJobError,
  type Handler,
  type HandlerContext,
  type Providers,
  type RunInfo,
  type SeedContext,
  type Seeder,
  type SeedPlan,
} from "./types.ts";

/** The worker loop of spec 7.5, with its dependencies injected so it can be tested with an in-memory Db. */

export interface LoopDeps {
  db: Db;
  worker: string;
  now(): number; // wall clock, epoch ms
  t0: number; // invocation start, epoch ms
  settings: PipelineSettings;
  stages: readonly JobStage[]; // the stages this worker may claim
  handlers: Partial<Record<JobStage, Handler>>;
  seeders: Partial<Record<JobStage, Seeder>>;
  loadRun(id: string): Promise<RunInfo>;
  providersFor(
    run: RunInfo,
    onEvent: (event: string, data: Record<string, unknown>) => void,
  ): Providers;
  activeRunIds(): Promise<string[]>;
}

export interface LoopSummary {
  jobsRun: number;
  jobsDone: number;
  jobsFailed: number;
  jobsDeferred: number;
  seeded: string[];
  stoppedBecause: "idle" | "time" | "heavy_cap" | "deadlock";
}

export type JobOutcome =
  | { kind: "defer"; delaySeconds: number; reason: string }
  | { kind: "fatal"; message: string }
  | { kind: "fail"; message: string; retryInSeconds?: number };

/** How a thrown error is handled (7.9): defer without an attempt, fatal at once, or fail with backoff. */
export function classifyError(e: unknown, nowMs: number): JobOutcome {
  if (e instanceof DeferError)
    return { kind: "defer", delaySeconds: e.delaySeconds, reason: e.reason };
  if (e instanceof YahooUnavailableError)
    return {
      kind: "defer",
      delaySeconds: Math.max(30, Math.ceil((e.untilMs - nowMs) / 1000)),
      reason: "yahoo_breaker_open",
    };
  if (e instanceof BudgetExceededError)
    return { kind: "defer", delaySeconds: 10, reason: "yahoo_budget_exceeded" };
  if (e instanceof FatalJobError || e instanceof SettingsError)
    return { kind: "fatal", message: e.message };
  if (e instanceof Error && e.message === "settings_not_signal_grade")
    return { kind: "fatal", message: e.message };
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError"))
    return { kind: "fail", message: "job_timeout", retryInSeconds: 30 };
  const name = e instanceof Error ? e.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "fail", message: `${name}: ${message}`.slice(0, 300) };
}

/** Stages whose jobs carry the CPU load (spec 7.4: 0.7-1 s CPU per fetch_bars job, about 3 MB of JSON per compute job). */
export const HEAVY_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "fetch_bars",
  "compute",
  "rank_signals",
  "portfolio_scan", // fetch + compute for the held securities
]);

/** Deferring a job this close to the hard deadline beats starting it with a 1 s abort signal that would burn an attempt. */
const DEADLINE_MARGIN_MS = 5_000;

const isDeadlock = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "40P01";

export async function runLoop(deps: LoopDeps): Promise<LoopSummary> {
  const { db, settings } = deps;
  const summary: LoopSummary = {
    jobsRun: 0,
    jobsDone: 0,
    jobsFailed: 0,
    jobsDeferred: 0,
    seeded: [],
    stoppedBecause: "idle",
  };
  const runs = new Map<string, RunInfo>();
  const providers = new Map<string, Providers>();
  const pendingEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const hardDeadline = deps.t0 + settings.hardDeadlineMs;
  const getRun = async (id: string): Promise<RunInfo> => {
    let run = runs.get(id);
    if (run === undefined) {
      run = await deps.loadRun(id);
      runs.set(id, run);
    }
    return run;
  };
  const getProviders = (run: RunInfo): Providers => {
    let p = providers.get(run.id);
    if (p === undefined) {
      p = deps.providersFor(run, (event, data) => pendingEvents.push({ event, data }));
      providers.set(run.id, p);
    }
    return p;
  };
  const flush = async (run: string, job: ScanJob | null): Promise<void> => {
    while (pendingEvents.length > 0) {
      const e = pendingEvents.shift() as { event: string; data: Record<string, unknown> };
      const level = e.event.endsWith("_open") || e.event === "yahoo_429" ? "warn" : "info";
      await scanEvent(
        db,
        { runId: run, jobId: job?.id ?? null, stage: job?.stage ?? null },
        e.event,
        e.data,
        { level },
      );
    }
  };

  const refreshActive = async (): Promise<void> => {
    for (const id of await deps.activeRunIds()) await db.refreshScanStatus(id);
  };

  const seedNext = async (): Promise<boolean> => {
    let any = false;
    for (const id of await deps.activeRunIds()) {
      const stage = await db.nextStageToSeed(id);
      if (stage === null) continue;
      const seeder = deps.seeders[stage];
      const run = await getRun(id);
      if (seeder === undefined) {
        await scanEvent(
          db,
          { runId: id, stage },
          "job_dead",
          { reason: "no_seeder" },
          { level: "error" },
        );
        continue;
      }
      const ctx: SeedContext = {
        db,
        run,
        providers: getProviders(run),
        log: (event: string, data?: Record<string, unknown>, extra?: EventExtra) =>
          scanEvent(db, { runId: id, stage }, event, data, extra),
      };
      let plan: SeedPlan;
      try {
        plan = await seeder(ctx);
      } catch (e) {
        await scanEvent(
          db,
          { runId: id, stage },
          "stage_seed_failed",
          { error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "error" },
          { level: "error" },
        );
        continue;
      }
      const n = await db.seedStage({
        run: id,
        stage,
        keys: plan.keys,
        ...(plan.payloads === undefined ? {} : { payloads: plan.payloads }),
        ...(plan.priorities === undefined ? {} : { priorities: plan.priorities }),
      });
      summary.seeded.push(`${id}:${stage}:${n}`);
      await scanEvent(db, { runId: id, stage }, "stage_seeded", {
        stage,
        jobs: plan.keys.length,
        inserted: n,
      });
      await flush(id, null);
      any = true;
    }
    return any;
  };

  const execute = async (job: ScanJob): Promise<void> => {
    summary.jobsRun += 1;
    const started = deps.now();
    const ctxLog = (event: string, data?: Record<string, unknown>, extra?: EventExtra) =>
      scanEvent(
        db,
        { runId: job.scan_run_id, jobId: job.id, stage: job.stage },
        event,
        data,
        extra,
      );
    await ctxLog("job_started", { job: job.key, attempt: job.attempts });
    try {
      const run = await getRun(job.scan_run_id);
      assertSignalGradeSettings(run.settings.indicator); // fails the scan with settings_not_signal_grade (A-34)
      const handler = deps.handlers[job.stage];
      if (handler === undefined) throw new FatalJobError(`no_handler:${job.stage}`);
      const ctx: HandlerContext = {
        db,
        job,
        run,
        providers: getProviders(run),
        signal: AbortSignal.timeout(Math.max(1000, hardDeadline - started)),
        deadlineMs: hardDeadline,
        log: ctxLog,
      };
      const result = await handler(ctx);
      await db.completeJob(job.id, result);
      summary.jobsDone += 1;
      await ctxLog("job_done", { job: job.key, ms: deps.now() - started });
    } catch (e) {
      const outcome = classifyError(e, deps.now());
      if (outcome.kind === "defer") {
        summary.jobsDeferred += 1;
        await db.deferJob(job.id, outcome.delaySeconds, outcome.reason);
        await ctxLog(
          "job_retry",
          {
            job: job.key,
            reason: outcome.reason,
            deferred_seconds: outcome.delaySeconds,
            attempt_consumed: false,
          },
          { level: "info" },
        );
      } else {
        summary.jobsFailed += 1;
        const status = await db.failJob({
          id: job.id,
          worker: deps.worker, // only the lease owner may fail the job (app.fail_job p_worker)
          error: outcome.message,
          fatal: outcome.kind === "fatal",
          ...(outcome.kind === "fail" && outcome.retryInSeconds !== undefined
            ? { retryInSeconds: outcome.retryInSeconds }
            : {}),
        });
        await ctxLog(
          status === null ? "job_lease_lost" : status === "dead" ? "job_dead" : "job_retry",
          { job: job.key, error: outcome.message, attempt: job.attempts },
          { level: status === "dead" ? "error" : "warn" },
        );
      }
    }
    await flush(job.scan_run_id, job);
  };

  await refreshActive(); // applies the soft and hard deadlines even when no job is runnable
  let heavyRun = 0;
  let deadlocks = 0;
  summary.stoppedBecause = "time";
  while (deps.now() - deps.t0 < settings.stopClaimingMs) {
    const heavyLeft = settings.maxHeavyJobsPerInvocation - heavyRun;
    if (heavyLeft <= 0) {
      summary.stoppedBecause = "heavy_cap";
      break;
    }
    let jobs: ScanJob[];
    try {
      jobs = await db.claimJobs({
        worker: deps.worker,
        limit: Math.min(settings.claimLimit, heavyLeft), // a claim never takes more heavy jobs than are left
        leaseSeconds: settings.leaseSeconds,
        stages: [...deps.stages],
        stageLimits: settings.stageCaps,
      });
    } catch (e) {
      if (!isDeadlock(e)) throw e;
      deadlocks += 1;
      await scanEvent(
        db,
        { runId: null },
        "claim_deadlock",
        { attempt: deadlocks },
        { level: "warn" },
      );
      if (deadlocks <= 1) continue; // the other claimer has finished by now: retry once
      summary.stoppedBecause = "deadlock";
      await refreshActive();
      return summary;
    }
    if (jobs.length === 0) {
      if (await seedNext()) continue;
      summary.stoppedBecause = "idle";
      await refreshActive();
      return summary;
    }
    let pastDeadline = false;
    for (const job of jobs) {
      if (pastDeadline || deps.now() >= hardDeadline - DEADLINE_MARGIN_MS) {
        pastDeadline = true;
        summary.jobsDeferred += 1;
        await db.deferJob(job.id, 0, "worker_deadline"); // releases the lease and gives the attempt back
        await scanEvent(
          db,
          { runId: job.scan_run_id, jobId: job.id, stage: job.stage },
          "job_retry",
          { job: job.key, reason: "worker_deadline", attempt_consumed: false },
          { level: "info" },
        );
        continue;
      }
      if (HEAVY_STAGES.has(job.stage)) heavyRun += 1;
      await execute(job);
    }
    for (const id of new Set(jobs.map((j) => j.scan_run_id))) await db.refreshScanStatus(id);
    if (pastDeadline) break; // the next claim would only hand the same jobs back
  }
  // A stage whose last job ended after the stop-claiming point has nobody left to seed its successor (the next minute tick only
  // fires for queued jobs, and the migration 20261015007700 kick covers the remaining case); seed before returning.
  await seedNext();
  await refreshActive();
  return summary;
}

export type { ScanEventRow };
