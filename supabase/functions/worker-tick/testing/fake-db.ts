import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db, ScanJob, ScanStatus } from "../../_shared/adapters/db.ts";
import type { JobStage, ScanEventRow } from "../../_shared/adapters/log.ts";
import { PIPELINE_ORDER } from "../stages.ts";

/** In-memory Db for loop and seeding tests. It mirrors the SQL semantics that matter: priority order, stage caps, attempts, idempotent seeding. */
export interface FakeDb extends Db {
  jobs: ScanJob[];
  events: ScanEventRow[];
  refreshes: string[];
  failures: Array<{ id: number; error: string; fatal: boolean; retryInSeconds: number | null }>;
  deferrals: Array<{ id: number; delaySeconds: number; reason: string }>;
  claims: Array<{ limit: number; stages: JobStage[]; stageLimits: Record<string, number> }>;
  addJob(job: Partial<ScanJob> & { stage: JobStage; key: string }): ScanJob;
  /** Retries and deferrals respect not_before in SQL; the fake keeps them blocked until the test releases them. */
  releaseAll(): void;
}

export function createFakeDb(runId = "run-1", sb?: SupabaseClient): FakeDb {
  let seq = 0;
  const jobs: ScanJob[] = [];
  const blocked = new Set<number>();
  const db: FakeDb = {
    sb: sb ?? (undefined as never),
    jobs,
    events: [],
    refreshes: [],
    failures: [],
    deferrals: [],
    claims: [],
    addJob(job) {
      const j: ScanJob = {
        id: ++seq,
        scan_run_id: runId,
        status: "queued",
        priority: 100,
        payload: {},
        result: null,
        attempts: 0,
        max_attempts: 5,
        not_before: "1970-01-01T00:00:00Z",
        lease_until: null,
        leased_by: null,
        last_error: null,
        ...job,
      };
      jobs.push(j);
      return j;
    },
    releaseAll() {
      blocked.clear();
    },
    claimJobs(a) {
      db.claims.push({ limit: a.limit, stages: a.stages, stageLimits: a.stageLimits });
      const out: ScanJob[] = [];
      const runnable = jobs
        .filter(
          (j) =>
            (j.status === "queued" || j.status === "failed") &&
            !blocked.has(j.id) &&
            a.stages.includes(j.stage),
        )
        .sort((x, y) => x.priority - y.priority || x.id - y.id);
      for (const j of runnable) {
        if (out.length >= a.limit) break;
        const cap = a.stageLimits[j.stage] ?? 1000;
        if (jobs.filter((x) => x.stage === j.stage && x.status === "leased").length >= cap)
          continue;
        j.status = "leased";
        j.leased_by = a.worker;
        j.attempts += 1;
        out.push({ ...j });
      }
      return Promise.resolve(out);
    },
    completeJob(id, result) {
      const j = jobs.find((x) => x.id === id);
      if (j !== undefined && j.status === "leased")
        Object.assign(j, { status: "done", result, leased_by: null });
      return Promise.resolve();
    },
    failJob(a) {
      db.failures.push({
        id: a.id,
        error: a.error,
        fatal: a.fatal ?? false,
        retryInSeconds: a.retryInSeconds ?? null,
      });
      const j = jobs.find((x) => x.id === a.id);
      // mirrors app.fail_job p_worker: only the lease owner may transition the job
      if (
        j === undefined ||
        (a.worker !== undefined && (j.status !== "leased" || j.leased_by !== a.worker))
      ) {
        return Promise.resolve(null);
      }
      const dead = (a.fatal ?? false) || j.attempts >= j.max_attempts;
      Object.assign(j, { status: dead ? "dead" : "failed", last_error: a.error, leased_by: null });
      if (!dead) blocked.add(j.id);
      return Promise.resolve(dead ? "dead" : "failed");
    },
    deferJob(id, delaySeconds, reason) {
      db.deferrals.push({ id, delaySeconds, reason });
      const j = jobs.find((x) => x.id === id);
      if (j !== undefined && j.status === "leased") {
        Object.assign(j, {
          status: "queued",
          attempts: Math.max(0, j.attempts - 1),
          last_error: reason,
          leased_by: null,
        });
        blocked.add(j.id);
      }
      return Promise.resolve();
    },
    heartbeatJob: () => Promise.resolve(),
    refreshScanStatus(run) {
      db.refreshes.push(run);
      return Promise.resolve("running" as ScanStatus);
    },
    seedStage(a) {
      let n = 0;
      if (a.keys.length === 0) {
        if (!jobs.some((j) => j.stage === a.stage && j.key === "_empty"))
          db.addJob({ stage: a.stage, key: "_empty", status: "done" });
        return Promise.resolve(0);
      }
      a.keys.forEach((key, i) => {
        if (jobs.some((j) => j.scan_run_id === a.run && j.stage === a.stage && j.key === key))
          return;
        db.addJob({
          scan_run_id: a.run,
          stage: a.stage,
          key,
          payload: (a.payloads?.[i] as Record<string, unknown>) ?? {},
          priority: a.priorities?.[i] ?? 100,
        });
        n += 1;
      });
      return Promise.resolve(n);
    },
    nextStageToSeed(run) {
      for (let i = 0; i < PIPELINE_ORDER.length; i++) {
        const stage = PIPELINE_ORDER[i] as JobStage;
        const have = jobs.filter((j) => j.scan_run_id === run && j.stage === stage);
        if (have.length > 0) continue;
        if (i === 0) return Promise.resolve(stage);
        const prev = jobs.filter((j) => j.scan_run_id === run && j.stage === PIPELINE_ORDER[i - 1]);
        if (prev.some((j) => ["queued", "leased", "failed"].includes(j.status)))
          return Promise.resolve(null);
        if (
          (PIPELINE_ORDER[i - 1] === "fx" || PIPELINE_ORDER[i - 1] === "rank_signals") &&
          prev.some((j) => j.status === "dead")
        )
          return Promise.resolve(null);
        return Promise.resolve(stage);
      }
      return Promise.resolve(null);
    },
    startDailyScan: () => Promise.resolve(null),
    purgeExpired: () => Promise.resolve({}),
    recordEvent(e) {
      db.events.push(e);
      return Promise.resolve();
    },
  };
  return db;
}
