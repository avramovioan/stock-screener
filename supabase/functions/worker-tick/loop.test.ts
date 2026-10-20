import { assert, assertEquals } from "@std/assert";
import { DbError } from "../_shared/adapters/db.ts";
import type { JobStage } from "../_shared/adapters/log.ts";
import {
  type AppSettings,
  DEFAULT_PIPELINE,
  DEFAULT_UNIVERSE,
  SettingsError,
} from "../_shared/adapters/settings.ts";
import { BudgetExceededError, YahooUnavailableError } from "../_shared/adapters/throttle.ts";
import { dayNumber } from "../_shared/core/calendar.ts";
import { DEFAULT_SETTINGS } from "../_shared/core/indicator.ts";
import { classifyError, type LoopDeps, runLoop } from "./loop.ts";
import { PIPELINE_ORDER } from "./stages.ts";
import { createFakeDb } from "./testing/fake-db.ts";
import { DeferError, FatalJobError, type Handler, type RunInfo, type Seeder } from "./types.ts";

const settings: AppSettings = {
  indicator: { ...DEFAULT_SETTINGS },
  universe: { ...DEFAULT_UNIVERSE },
  pipeline: { ...DEFAULT_PIPELINE, maxHeavyJobsPerInvocation: 1000 }, // the CPU guard has its own tests below
};
const run = (over: Partial<RunInfo> = {}): RunInfo => ({
  id: "run-1",
  scanDateLocal: "2026-10-15",
  scanDay: dayNumber(2026, 10, 15),
  startedAtMs: Date.UTC(2026, 9, 15, 7),
  settings,
  providerMode: "live",
  fixtureSet: null,
  ...over,
});

function deps(
  db: ReturnType<typeof createFakeDb>,
  over: Partial<LoopDeps> = {},
): { deps: LoopDeps; clock: { t: number } } {
  const clock = { t: 0 };
  return {
    clock,
    deps: {
      db,
      worker: "w1",
      now: () => clock.t,
      t0: 0,
      settings: settings.pipeline,
      stages: PIPELINE_ORDER,
      handlers: {},
      seeders: {},
      loadRun: () => Promise.resolve(run()),
      providersFor: () => ({ market: undefined as never, fx: undefined as never }),
      activeRunIds: () => Promise.resolve(["run-1"]),
      ...over,
    },
  };
}

// ---------------------------------------------------------------------------------------------------- error classification

Deno.test("classifyError: one row per failure class of spec 7.9", () => {
  const now = 1_000_000;
  assertEquals(classifyError(new DeferError(30, "waiting"), now), {
    kind: "defer",
    delaySeconds: 30,
    reason: "waiting",
  });
  assertEquals(classifyError(new YahooUnavailableError(now + 600_000), now), {
    kind: "defer",
    delaySeconds: 600,
    reason: "yahoo_breaker_open",
  });
  assertEquals(classifyError(new YahooUnavailableError(now + 1000), now), {
    kind: "defer",
    delaySeconds: 30,
    reason: "yahoo_breaker_open",
  }); // never sooner than 30 s
  assertEquals(classifyError(new BudgetExceededError(), now), {
    kind: "defer",
    delaySeconds: 10,
    reason: "yahoo_budget_exceeded",
  });
  assertEquals(classifyError(new FatalJobError("unknown_exchange:XXX"), now), {
    kind: "fatal",
    message: "unknown_exchange:XXX",
  });
  assertEquals(classifyError(new SettingsError("invalid_indicator_settings"), now).kind, "fatal");
  assertEquals(classifyError(new Error("settings_not_signal_grade"), now), {
    kind: "fatal",
    message: "settings_not_signal_grade",
  });
  assertEquals(classifyError(new DOMException("t", "TimeoutError"), now), {
    kind: "fail",
    message: "job_timeout",
    retryInSeconds: 30,
  });
  const generic = classifyError(new TypeError("x".repeat(500)), now);
  assertEquals(generic.kind, "fail");
  assert(
    (generic as { message: string }).message.startsWith("TypeError: xxx") &&
      (generic as { message: string }).message.length <= 300,
    "error text is bounded, no payload dump",
  );
  assertEquals(classifyError("boom", now), { kind: "fail", message: "Error: boom" });
});

// ---------------------------------------------------------------------------------------------------- the loop

Deno.test("runLoop claims jobs in priority order, runs their handlers, completes them and refreshes the run status", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", priority: 10 });
  db.addJob({ stage: "compute", key: "compute:0", priority: 100 });
  const order: string[] = [];
  const h: Handler = (ctx) => {
    order.push(`${ctx.job.stage}:${ctx.job.key}`);
    return Promise.resolve({ ok: true });
  };
  const { deps: d } = deps(db, { handlers: { fx: h, compute: h } });
  const summary = await runLoop(d);
  assertEquals(order, ["fx:all", "compute:compute:0"]);
  assertEquals(
    [summary.jobsRun, summary.jobsDone, summary.jobsFailed, summary.stoppedBecause],
    [2, 2, 0, "idle"],
  );
  assertEquals(
    db.jobs.map((j) => j.status),
    ["done", "done"],
  );
  assertEquals(db.jobs[0]?.result, { ok: true });
  assert(db.refreshes.includes("run-1"));
  assertEquals(db.events.filter((e) => e.event === "job_started").length, 2);
  assertEquals(db.events.filter((e) => e.event === "job_done").length, 2);
});

Deno.test("runLoop passes the stage caps and the lease to claim_jobs", async () => {
  const db = createFakeDb();
  const { deps: d } = deps(db);
  await runLoop(d);
  assertEquals(db.claims[0]?.stageLimits, DEFAULT_PIPELINE.stageCaps);
  assertEquals(db.claims[0]?.limit, 3);
  assertEquals(db.claims[0]?.stages, PIPELINE_ORDER);
});

Deno.test("stage seeding transitions: the loop walks fx -> universe_sweep -> ... -> publish, seeding each stage only after the previous one finished", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", priority: 10 });
  const seen: JobStage[] = [];
  const handler: Handler = (ctx) => {
    seen.push(ctx.job.stage);
    return Promise.resolve({});
  };
  const seeder =
    (stage: JobStage): Seeder =>
    () =>
      Promise.resolve({
        keys: stage === "identity" ? [] : [`${stage}:0`, `${stage}:1`],
        priorities: [100, 100],
      });
  const handlers = Object.fromEntries(PIPELINE_ORDER.map((s) => [s, handler]));
  const seeders = Object.fromEntries(PIPELINE_ORDER.map((s) => [s, seeder(s)]));
  const { deps: d } = deps(db, { handlers, seeders });
  const summary = await runLoop(d);
  assertEquals(seen[0], "fx");
  const stageOrder = seen.filter((s, i) => seen.indexOf(s) === i);
  assertEquals(
    stageOrder,
    PIPELINE_ORDER.filter((s) => s !== "identity"),
  ); // an empty stage only leaves a done marker
  assertEquals(
    db.jobs.filter((j) => j.stage === "identity").map((j) => [j.key, j.status]),
    [["_empty", "done"]],
  );
  assertEquals(db.jobs.filter((j) => j.status !== "done").length, 0);
  assertEquals(summary.seeded.length, PIPELINE_ORDER.length - 1);
  assertEquals(summary.stoppedBecause, "idle");
  // each stage's jobs started only after every job of the previous stage was done: no interleaving
  for (let i = 1; i < stageOrder.length; i++)
    assert(
      seen.lastIndexOf(stageOrder[i - 1] as JobStage) < seen.indexOf(stageOrder[i] as JobStage),
    );
  assertEquals(
    db.events.filter((e) => e.event === "stage_seeded").length,
    PIPELINE_ORDER.length - 1,
  );
});

Deno.test("seeding is idempotent: a second worker seeding the same stage creates no duplicates", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", status: "done" });
  assertEquals(
    await db.seedStage({ run: "run-1", stage: "universe_sweep", keys: ["NMS", "GER"] }),
    2,
  );
  assertEquals(
    await db.seedStage({ run: "run-1", stage: "universe_sweep", keys: ["NMS", "GER"] }),
    0,
  );
  assertEquals(db.jobs.filter((j) => j.stage === "universe_sweep").length, 2);
});

Deno.test("a handler error fails the job with backoff, a fatal error kills it at once, a deferral does not consume an attempt", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "boom" });
  db.addJob({ stage: "compute", key: "fatal" });
  db.addJob({ stage: "fetch_bars", key: "defer" });
  const handlers: Partial<Record<JobStage, Handler>> = {
    fx: () => Promise.reject(new TypeError("kaput")),
    compute: () => Promise.reject(new FatalJobError("unknown_exchange:XXX")),
    fetch_bars: () => Promise.reject(new YahooUnavailableError(Date.now() + 120_000)),
  };
  const { deps: d } = deps(db, { handlers, activeRunIds: () => Promise.resolve([]) });
  const summary = await runLoop(d);
  assertEquals([summary.jobsFailed, summary.jobsDeferred], [2, 1]);
  assertEquals(db.jobs.find((j) => j.key === "boom")?.status, "failed");
  assertEquals(db.jobs.find((j) => j.key === "fatal")?.status, "dead");
  assertEquals(db.failures.find((f) => f.error === "unknown_exchange:XXX")?.fatal, true);
  const deferred = db.jobs.find((j) => j.key === "defer");
  assertEquals([deferred?.status, deferred?.attempts], ["queued", 0]);
  assert(db.events.some((e) => e.event === "job_retry" && e.level === "warn"));
  assert(db.events.some((e) => e.event === "job_dead" && e.level === "error"));
  const ev = db.events.find((e) => e.event === "job_dead");
  assert(
    !JSON.stringify(ev).includes("kaput"),
    "a dead job logs the error class of the fatal error only",
  );
});

Deno.test("a job that fails five times is dead (max_attempts)", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "flaky" });
  const { deps: d } = deps(db, {
    handlers: { fx: () => Promise.reject(new Error("again")) },
    activeRunIds: () => Promise.resolve([]),
  });
  for (let i = 0; i < 5; i++) {
    db.releaseAll(); // time passes: not_before is reached
    await runLoop(d);
  }
  assertEquals(db.jobs[0]?.status, "dead");
  assertEquals(db.jobs[0]?.attempts, 5);
});

Deno.test("a stage without a handler is fatal for its job", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const { deps: d } = deps(db, { activeRunIds: () => Promise.resolve([]) });
  await runLoop(d);
  assertEquals(db.jobs[0]?.status, "dead");
  assertEquals(db.failures[0]?.error, "no_handler:fx");
});

Deno.test("signal-grade guard: a run whose indicator settings are not the 3/4/1/2 defaults fails every job with settings_not_signal_grade", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const custom = run({
    settings: { ...settings, indicator: { ...DEFAULT_SETTINGS, lower1Mag: 2 } },
  });
  let called = false;
  const { deps: d } = deps(db, {
    loadRun: () => Promise.resolve(custom),
    handlers: {
      fx: () => {
        called = true;
        return Promise.resolve({});
      },
    },
    activeRunIds: () => Promise.resolve([]),
  });
  await runLoop(d);
  assertEquals(called, false);
  assertEquals(db.jobs[0]?.status, "dead");
  assertEquals(db.failures[0], {
    id: 1,
    error: "settings_not_signal_grade",
    fatal: true,
    retryInSeconds: null,
  });
});

Deno.test("a length-only change is still signal-grade", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const ok = run({ settings: { ...settings, indicator: { ...DEFAULT_SETTINGS, length: 2000 } } });
  const { deps: d } = deps(db, {
    loadRun: () => Promise.resolve(ok),
    handlers: { fx: () => Promise.resolve({}) },
    activeRunIds: () => Promise.resolve([]),
  });
  await runLoop(d);
  assertEquals(db.jobs[0]?.status, "done");
});

Deno.test("the loop stops claiming after 85 s of wall time", async () => {
  const db = createFakeDb();
  for (let i = 0; i < 10; i++) db.addJob({ stage: "compute", key: `c${i}` });
  const { deps: d, clock } = deps(db, { activeRunIds: () => Promise.resolve([]) });
  d.handlers = {
    compute: () => {
      clock.t += 40_000;
      return Promise.resolve({});
    },
  }; // each job takes 40 s
  const summary = await runLoop(d);
  assertEquals(summary.stoppedBecause, "time");
  // compute is capped at 2 concurrent jobs: claim 1 (t = 0) runs 2 jobs until t = 80 s, which is still < 85 s, so claim 2 runs 2 more until t = 160 s;
  // from then on the loop no longer claims. Of the second claim only the first job starts (t = 80 s); the second would start at t = 120 s,
  // inside the last 5 s before the hard deadline (115 s), so it is deferred without an attempt instead of being run with a 1 s signal.
  assertEquals(summary.jobsRun, 3);
  assertEquals(summary.jobsDeferred, 1);
  assertEquals(db.jobs.filter((j) => j.status === "queued").length, 7);
  assertEquals(db.jobs.filter((j) => j.attempts > 0).length, 3);
});

Deno.test("an idle loop with nothing to claim or seed returns at once", async () => {
  const db = createFakeDb();
  const { deps: d } = deps(db, { activeRunIds: () => Promise.resolve([]) });
  const summary = await runLoop(d);
  assertEquals(summary, {
    jobsRun: 0,
    jobsDone: 0,
    jobsFailed: 0,
    jobsDeferred: 0,
    seeded: [],
    stoppedBecause: "idle",
  });
});

Deno.test("a seeder that throws is logged and does not crash the worker", async () => {
  const db = createFakeDb();
  const { deps: d } = deps(db, { seeders: { fx: () => Promise.reject(new Error("db down")) } });
  const summary = await runLoop(d);
  assertEquals(summary.stoppedBecause, "idle");
  assert(db.events.some((e) => e.event === "stage_seed_failed" && e.level === "error"));
});

Deno.test("provider events recorded by the throttle are flushed as scan_events after the job", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const { deps: d } = deps(db, {
    activeRunIds: () => Promise.resolve([]),
    providersFor: (_run, onEvent) => {
      onEvent("yahoo_429", { attempt: 1, apiKey: "SECRET" });
      return { market: undefined as never, fx: undefined as never };
    },
    handlers: { fx: () => Promise.resolve({}) },
  });
  await runLoop(d);
  const e = db.events.find((x) => x.event === "yahoo_429");
  assertEquals(e?.level, "warn");
  assertEquals(e?.jobId, 1);
  assert(!JSON.stringify(e).includes("SECRET"));
});

Deno.test("failures carry the claiming worker id; a job another worker leased is not failed by this one", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const seen: Array<string | undefined> = [];
  const original = db.failJob.bind(db);
  db.failJob = (a) => {
    seen.push(a.worker);
    return original(a);
  };
  const { deps: d } = deps(db, {
    handlers: { fx: () => Promise.reject(new Error("x")) },
    activeRunIds: () => Promise.resolve([]),
  });
  await runLoop(d);
  assertEquals(seen, ["w1"]);
  assertEquals(db.jobs[0]?.status, "failed");
  // the lease belongs to somebody else: a late failure of the old worker is a no-op
  const job = db.addJob({ stage: "compute", key: "stolen", status: "leased", leased_by: "other" });
  assertEquals(await db.failJob({ id: job.id, error: "late", worker: "w1" }), null);
  assertEquals(db.jobs.find((j) => j.key === "stolen")?.status, "leased");
});

// ---------------------------------------------------------------------------------------------------- final fix wave A

const ok: Handler = () => Promise.resolve({});

Deno.test("CPU guard: after max_heavy_jobs_per_invocation heavy jobs the worker stops claiming and returns", async () => {
  const db = createFakeDb();
  for (let i = 0; i < 5; i++) db.addJob({ stage: "fetch_bars", key: `bars:${i}`, priority: 100 });
  db.addJob({ stage: "fx", key: "all", priority: 1 }); // not heavy: never counted
  const { deps: d } = deps(db, {
    handlers: { fx: ok, fetch_bars: ok },
    settings: { ...settings.pipeline, maxHeavyJobsPerInvocation: 2 },
  });
  const summary = await runLoop(d);
  assertEquals(summary.jobsRun, 3, "fx plus two heavy jobs");
  assertEquals(summary.stoppedBecause, "heavy_cap");
  assertEquals(db.jobs.filter((j) => j.status === "queued").length, 3);
  assert(
    db.claims.every((c) => c.limit <= 3),
    "a claim never asks for more than claimLimit",
  );
});

Deno.test("CPU guard: a claim never takes more heavy jobs than the invocation has left", async () => {
  const db = createFakeDb();
  for (let i = 0; i < 4; i++) db.addJob({ stage: "compute", key: `compute:${i}` });
  const { deps: d } = deps(db, {
    handlers: { compute: ok },
    settings: { ...settings.pipeline, maxHeavyJobsPerInvocation: 2, claimLimit: 3 },
  });
  await runLoop(d);
  assertEquals(db.jobs.filter((j) => j.status === "done").length, 2);
  assertEquals(db.jobs.filter((j) => j.attempts > 0).length, 2, "no job was claimed and left idle");
});

Deno.test("stage boundary: the time exit seeds the next stage once before returning", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", status: "done" });
  const { deps: d, clock } = deps(db, {
    seeders: { universe_sweep: () => Promise.resolve({ keys: ["NMS"], priorities: [100] }) },
  });
  clock.t = 90_000; // past stop_claiming_ms (85 s): the loop body never runs
  const summary = await runLoop(d);
  assertEquals(summary.stoppedBecause, "time");
  assertEquals(summary.seeded.length, 1);
  assertEquals(
    db.jobs.filter((j) => j.stage === "universe_sweep").map((j) => j.key),
    ["NMS"],
  );
});

Deno.test("claim_jobs deadlock (40P01): retried once, then the worker ends gracefully", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const real = db.claimJobs.bind(db);
  let calls = 0;
  db.claimJobs = (a) => {
    calls += 1;
    if (calls === 1) return Promise.reject(new DbError("claim_jobs", "deadlock detected", "40P01"));
    return real(a);
  };
  const { deps: d } = deps(db, { handlers: { fx: ok } });
  const once = await runLoop(d);
  assertEquals(once.jobsDone, 1, "the retry claimed the job");

  const db2 = createFakeDb();
  db2.addJob({ stage: "fx", key: "all" });
  db2.claimJobs = () => Promise.reject(new DbError("claim_jobs", "deadlock detected", "40P01"));
  const { deps: d2 } = deps(db2, { handlers: { fx: ok } });
  const twice = await runLoop(d2);
  assertEquals(twice.stoppedBecause, "deadlock");
  assertEquals(twice.jobsRun, 0);
  assert(db2.events.some((e) => e.event === "claim_deadlock"));
});

Deno.test("claim_jobs errors other than a deadlock still propagate", async () => {
  const db = createFakeDb();
  db.claimJobs = () => Promise.reject(new DbError("claim_jobs", "boom", "XX000"));
  const { deps: d } = deps(db);
  let thrown = false;
  await runLoop(d).catch(() => {
    thrown = true;
  });
  assert(thrown);
});

Deno.test("a claimed job that would start within 5 s of the hard deadline is deferred without consuming an attempt", async () => {
  const db = createFakeDb();
  const job = db.addJob({ stage: "fx", key: "all" });
  let ran = 0;
  const { deps: d, clock } = deps(db, {
    settings: { ...settings.pipeline, stopClaimingMs: 101_000, hardDeadlineMs: 105_000 },
    handlers: {
      fx: () => {
        ran += 1;
        return Promise.resolve({});
      },
    },
  });
  clock.t = 100_500; // inside the last 5 s before the hard deadline (105 s), still before stop_claiming_ms (101 s)
  const summary = await runLoop(d);
  assertEquals(ran, 0);
  assertEquals(db.deferrals, [{ id: job.id, delaySeconds: 0, reason: "worker_deadline" }]);
  assertEquals(db.jobs[0]?.attempts, 0);
  assertEquals(summary.jobsDeferred, 1);
  assertEquals(summary.stoppedBecause, "time", "the loop ends instead of re-claiming the job");
});
