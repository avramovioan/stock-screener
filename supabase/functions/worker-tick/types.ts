import type { Db, ScanJob } from "../_shared/adapters/db.ts";
import type { EventLevel } from "../_shared/adapters/log.ts";
import type { FxProvider, MarketDataProvider } from "../_shared/adapters/providers.ts";
import type { AppSettings } from "../_shared/adapters/settings.ts";

/** Everything a handler needs to know about the run, loaded once per worker invocation. */
export interface RunInfo {
  id: string;
  scanDateLocal: string; // Europe/Sofia date "YYYY-MM-DD"
  scanDay: number; // the same date as days since 1970-01-01
  startedAtMs: number; // the data reference time: forming-bar and freshness rules are evaluated at the scan start, so recomputes replay
  settings: AppSettings; // from scan_runs.settings_snapshot, never from the live app_settings
  providerMode: "live" | "fixture";
  fixtureSet: string | null;
}

export interface Providers {
  market: MarketDataProvider;
  fx: FxProvider;
}

export interface EventExtra {
  level?: EventLevel;
  securityId?: string | null;
  message?: string | null;
}

export interface HandlerContext {
  db: Db;
  job: ScanJob;
  run: RunInfo;
  providers: Providers;
  signal: AbortSignal;
  /** Epoch ms after which a handler must stop starting work (hard deadline of the invocation). */
  deadlineMs: number;
  log(event: string, data?: Record<string, unknown>, extra?: EventExtra): Promise<void>;
}

export type Handler = (ctx: HandlerContext) => Promise<Record<string, unknown>>;

export interface SeedContext {
  db: Db;
  run: RunInfo;
  providers: Providers;
  log(event: string, data?: Record<string, unknown>, extra?: EventExtra): Promise<void>;
}

export interface SeedPlan {
  keys: string[];
  payloads?: unknown[];
  priorities?: number[];
}

export type Seeder = (ctx: SeedContext) => Promise<SeedPlan>;

/** Reschedule the job without consuming an attempt (breaker open, waiting for sibling jobs). */
export class DeferError extends Error {
  constructor(
    readonly delaySeconds: number,
    readonly reason: string,
  ) {
    super(`deferred: ${reason}`);
    this.name = "DeferError";
  }
}

/** Fatal configuration problem: the job goes dead at once and the scan fails (signal-grade guard, missing secret). */
export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJobError";
  }
}
