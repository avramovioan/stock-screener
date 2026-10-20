import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.ts";
import type { EventSink, JobStage, ScanEventRow } from "./log.ts";
import type { KvStore } from "./store.ts";

/** Service-role access. Edge Functions only: it bypasses RLS and must never reach a browser or a log line. */

export interface ScanJob {
  id: number;
  scan_run_id: string;
  stage: JobStage;
  key: string;
  status: "queued" | "leased" | "done" | "failed" | "dead";
  priority: number;
  payload: Record<string, unknown>;
  result: unknown;
  attempts: number;
  max_attempts: number;
  not_before: string;
  lease_until: string | null;
  leased_by: string | null;
  last_error: string | null;
}

export type ScanStatus = "queued" | "running" | "partial" | "complete" | "failed";

export class DbError extends Error {
  constructor(
    readonly op: string,
    message: string,
    readonly code: string | null = null,
  ) {
    super(`${op}: ${message}`);
    this.name = "DbError";
  }
}

/** The pipeline-facing surface. Handlers receive this; tests replace it with an in-memory fake. `sb` is raw table access. */
export interface Db extends EventSink {
  readonly sb: SupabaseClient;
  claimJobs(a: {
    worker: string;
    limit: number;
    leaseSeconds: number;
    stages: JobStage[];
    stageLimits: Record<string, number>;
  }): Promise<ScanJob[]>;
  completeJob(id: number, result: unknown): Promise<void>;
  failJob(a: {
    id: number;
    error: string;
    retryInSeconds?: number | null;
    fatal?: boolean;
    /** Lease owner: when passed, only a job leased by this worker is transitioned (app.fail_job p_worker). */
    worker?: string;
  }): Promise<"failed" | "dead" | null>;
  deferJob(id: number, delaySeconds: number, reason: string): Promise<void>;
  heartbeatJob(id: number, extendSeconds: number): Promise<void>;
  refreshScanStatus(run: string): Promise<ScanStatus | null>;
  seedStage(a: {
    run: string;
    stage: JobStage;
    keys: string[];
    payloads?: unknown[];
    priorities?: number[];
  }): Promise<number>;
  nextStageToSeed(run: string): Promise<JobStage | null>;
  startDailyScan(a: {
    now?: string;
    force?: boolean;
    trigger?: "cron" | "cron_catchup" | "manual";
    snapshotExtra?: Record<string, unknown>;
  }): Promise<string | null>;
  purgeExpired(): Promise<Record<string, number>>;
}

const secs = (n: number): string => `${Math.max(0, Math.round(n))} seconds`;

export function createDb(sb: SupabaseClient): Db {
  const app = () => sb.schema("app");
  async function call<T>(op: string, name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await app().rpc(name, args);
    if (error) throw new DbError(op, error.message, error.code ?? null);
    return data as T;
  }
  return {
    sb,

    async claimJobs(a) {
      const rows = await call<ScanJob[] | null>("claim_jobs", "claim_jobs", {
        p_worker: a.worker,
        p_limit: a.limit,
        p_lease: secs(a.leaseSeconds),
        p_stages: a.stages,
        p_stage_limits: a.stageLimits,
      });
      return rows ?? [];
    },
    async completeJob(id, result) {
      await call<null>("complete_job", "complete_job", { p_id: id, p_result: result ?? null });
    },
    async failJob(a) {
      const args: Record<string, unknown> = {
        p_id: a.id,
        p_error: a.error,
        p_fatal: a.fatal ?? false,
      };
      if (a.retryInSeconds !== undefined && a.retryInSeconds !== null)
        args["p_retry_in"] = secs(a.retryInSeconds);
      if (a.worker !== undefined) args["p_worker"] = a.worker;
      return await call<"failed" | "dead" | null>("fail_job", "fail_job", args);
    },
    async deferJob(id, delaySeconds, reason) {
      await call<null>("defer_job", "defer_job", {
        p_id: id,
        p_delay: secs(delaySeconds),
        p_reason: reason,
      });
    },
    async heartbeatJob(id, extendSeconds) {
      await call<null>("heartbeat_job", "heartbeat_job", {
        p_id: id,
        p_extend: secs(extendSeconds),
      });
    },
    async refreshScanStatus(run) {
      return await call<ScanStatus | null>("refresh_scan_status", "refresh_scan_status", {
        p_run: run,
      });
    },
    async seedStage(a) {
      const args: Record<string, unknown> = { p_run: a.run, p_stage: a.stage, p_keys: a.keys };
      if (a.payloads !== undefined) args["p_payloads"] = a.payloads;
      if (a.priorities !== undefined) args["p_priorities"] = a.priorities;
      return await call<number>("seed_stage", "seed_stage", args);
    },
    async nextStageToSeed(run) {
      return await call<JobStage | null>("next_stage_to_seed", "next_stage_to_seed", {
        p_run: run,
      });
    },
    async startDailyScan(a) {
      return await call<string | null>("start_daily_scan", "start_daily_scan", {
        p_now: a.now ?? new Date().toISOString(),
        p_force: a.force ?? false,
        p_trigger: a.trigger ?? "cron",
        p_snapshot_extra: a.snapshotExtra ?? {},
      });
    },
    async purgeExpired() {
      return await call<Record<string, number>>("purge_expired", "purge_expired", {});
    },
    async recordEvent(e: ScanEventRow) {
      await call<null>("record_event", "record_event", {
        p_run: e.runId,
        p_event: e.event,
        p_level: e.level,
        p_stage: e.stage,
        p_job: e.jobId,
        p_security: e.securityId,
        p_message: e.message,
        p_data: e.data,
      });
    },
  };
}

/** Service-role client with no session persistence (Edge Functions are stateless). */
export function createServiceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createServiceDb(): Db {
  return createDb(createServiceClient());
}

/** quote_cache-backed KvStore: Yahoo session and breaker state survive across isolates. */
export function createQuoteCacheKv(sb: SupabaseClient, now: () => number = Date.now): KvStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const { data, error } = await sb
        .from("quote_cache")
        .select("payload, expires_at")
        .eq("key", key)
        .maybeSingle();
      if (error) throw new DbError("quote_cache.get", error.message, error.code ?? null);
      if (data === null || Date.parse(data.expires_at as string) <= now()) return null;
      return data.payload as T;
    },
    async set(key, value, ttlMs) {
      const { error } = await sb.from("quote_cache").upsert(
        {
          key,
          payload: value as Record<string, unknown>,
          provider: "yahoo",
          fetched_at: new Date(now()).toISOString(),
          expires_at: new Date(now() + ttlMs).toISOString(),
        },
        { onConflict: "key" },
      );
      if (error) throw new DbError("quote_cache.set", error.message, error.code ?? null);
    },
    async delete(key) {
      const { error } = await sb.from("quote_cache").delete().eq("key", key);
      if (error) throw new DbError("quote_cache.delete", error.message, error.code ?? null);
    },
  };
}
