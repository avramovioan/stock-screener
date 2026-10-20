import type { ScanJob } from "../../_shared/adapters/db.ts";
import {
  type AppSettings,
  DEFAULT_PIPELINE,
  DEFAULT_UNIVERSE,
} from "../../_shared/adapters/settings.ts";
import { dayNumber } from "../../_shared/core/calendar.ts";
import { DEFAULT_SETTINGS } from "../../_shared/core/indicator.ts";
import type { HandlerContext, RunInfo } from "../types.ts";
import { createFakeDb } from "./fake-db.ts";
import type { FakeSb } from "./fake-sb.ts";

export const RUN_ID = "run-today";

export function testSettings(length = 30): AppSettings {
  return {
    indicator: { ...DEFAULT_SETTINGS, length },
    universe: { ...DEFAULT_UNIVERSE },
    pipeline: { ...DEFAULT_PIPELINE },
  };
}

export function testRun(over: Partial<RunInfo> = {}): RunInfo {
  return {
    id: RUN_ID,
    scanDateLocal: "2026-10-15",
    scanDay: dayNumber(2026, 10, 15),
    startedAtMs: Date.UTC(2026, 9, 15, 7),
    settings: testSettings(),
    providerMode: "fixture",
    fixtureSet: "day1",
    ...over,
  };
}

/** A handler context over the fake PostgREST client (events and job bookkeeping go to the in-memory Db). */
export function testCtx(
  sb: FakeSb,
  payload: Record<string, unknown> = {},
  run: RunInfo = testRun(),
): HandlerContext & { events: string[] } {
  const db = createFakeDb(run.id, sb.client);
  const job: ScanJob = db.addJob({ stage: "compute", key: "x:0", payload, scan_run_id: run.id });
  const events: string[] = [];
  return {
    db,
    job,
    run,
    providers: { market: undefined as never, fx: undefined as never },
    signal: new AbortController().signal,
    deadlineMs: Number.MAX_SAFE_INTEGER,
    log: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    events,
  };
}
