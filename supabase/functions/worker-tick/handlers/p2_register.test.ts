import { assert, assertEquals } from "@std/assert";
import type { JobStage } from "../../_shared/adapters/log.ts";
import { PIPELINE_ORDER } from "../stages.ts";
import { testCtx } from "../testing/ctx.ts";
import { createFakeSb } from "../testing/fake-sb.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";
import { P2_STAGES, registerP2, withP2 } from "./p2_register.ts";
import { FakeMonitor } from "./testing/fake_monitor.ts";
import { makeWorld, SEC_1 } from "./testing/fakes.ts";

const p1Handler: Handler = () => Promise.resolve({ p1: true });
const p1Seeder: Seeder = () => Promise.resolve({ keys: ["classify:initial"], priorities: [100] });

function ctxFor(
  stage: JobStage,
  key: string,
  payload: Record<string, unknown>,
  jobs: Array<Record<string, unknown>> = [],
): HandlerContext {
  const sb = createFakeSb({ scan_jobs: jobs });
  const base = testCtx(sb, payload);
  return {
    ...base,
    job: { ...base.job, stage, key },
    providers: {
      market: {
        news: () =>
          Promise.resolve([
            {
              id: "n1",
              title: "Acme guides lower",
              publisher: "Wire",
              url: "https://finance.yahoo.com/n/n1",
              publishedMs: Date.parse("2026-10-14T10:00:00Z"),
              relatedTickers: ["ACME"],
            },
          ]),
      } as never,
      fx: undefined as never,
    },
  };
}

Deno.test("withP2 adds the news and research stages, handlers and seeders without touching P1's list", () => {
  const w = makeWorld();
  const merged = withP2(
    {
      stages: PIPELINE_ORDER,
      handlers: { classify: p1Handler, publish: p1Handler },
      seeders: { classify: p1Seeder, publish: p1Seeder },
    },
    registerP2(w.deps),
  );
  assertEquals(merged.stages, [...PIPELINE_ORDER, ...P2_STAGES]);
  assert(merged.handlers.research && merged.handlers.news);
  assert(merged.seeders.research && merged.seeders.news);
  assertEquals(PIPELINE_ORDER.includes("news"), false);
});

Deno.test("classify and publish: the :final keys are P2's, every other key stays P1's", async () => {
  const w = makeWorld();
  w.store.cards.length = 0;
  const p2 = registerP2(w.deps);
  const classify = p2.wrapClassify(p1Handler);
  const publish = p2.wrapPublish(p1Handler);
  assertEquals(await classify(ctxFor("classify", "classify:initial", {})), { p1: true });
  assertEquals(await publish(ctxFor("publish", "publish:initial", {})), { p1: true });
  const finalClassify = await classify(ctxFor("classify", "classify:final", {}));
  assertEquals(finalClassify, { cards: 0, categories: {} });
  const finalPublish = await publish(ctxFor("publish", "publish:final", {}));
  assertEquals(Object.keys(finalPublish), [
    "cards",
    "complete",
    "pending",
    "deferred",
    "quota_deferred",
    "failed",
    "not_configured",
    "reused",
  ]);
  assertEquals(w.store.refreshed, ["run-today"]);
});

Deno.test("the classify / publish seeder seeds :final once :initial exists and delegates to P1 before that", async () => {
  const w = makeWorld();
  const p2 = registerP2(w.deps);
  const wrapped = p2.wrapSeeder("classify", p1Seeder);
  const seedCtx = (jobs: Array<Record<string, unknown>>) => {
    const c = ctxFor("classify", "x", {}, jobs);
    return { db: c.db, run: c.run, providers: c.providers, log: c.log };
  };
  assertEquals(await wrapped(seedCtx([])), { keys: ["classify:initial"], priorities: [100] });
  const runId = "run-today";
  const initial = { scan_run_id: runId, stage: "classify", key: "classify:initial" };
  assertEquals(await wrapped(seedCtx([initial])), { keys: ["classify:final"], priorities: [100] });
  const otherRun = { scan_run_id: "run-other", stage: "classify", key: "classify:initial" };
  assertEquals(await wrapped(seedCtx([otherRun])), {
    keys: ["classify:initial"],
    priorities: [100],
  });
});

Deno.test("the research seeder returns a SeedPlan (keys, payloads, priorities) for the P1 seed_stage", async () => {
  const w = makeWorld();
  const p2 = registerP2(w.deps);
  const deferred = await w.store.createReport({
    idempotencyKey: "k-def",
    securityId: "sec-1",
    companyId: "co-1",
    scanRunId: "run-0",
    trigger: "monitor_first",
    visibility: "holders",
  });
  await w.store.patchReport(deferred.id, {
    status: "quota_deferred",
    step: "extract:2",
    notBefore: "2026-10-15T00:05:00.000Z",
  });
  const c = ctxFor("research", "x", {});
  const plan = await p2.seeders.research({
    db: c.db,
    run: { ...c.run, id: "run-1", scanDateLocal: "2026-10-15" },
    providers: c.providers,
    log: c.log,
  });
  // the scan researches nothing by itself: the plan has no new_discount jobs any more
  assertEquals(plan.keys, [`research:${deferred.id}:extract:2:resume:2026-10-15`]);
  assertEquals(plan.priorities, [30]);
  assertEquals(plan.payloads, [
    {
      security_id: "sec-1",
      trigger: "monitor_first",
      scan_date_local: "2026-10-15",
      report_id: deferred.id,
      step: "extract:2",
    },
  ]);
  const news = await p2.seeders.news({
    db: c.db,
    run: { ...c.run, id: "run-1", scanDateLocal: "2026-10-15" },
    providers: c.providers,
    log: c.log,
  });
  assertEquals(news.keys, ["news:sec-1"]);
  // the seeders only plan: nothing is enqueued behind seed_stage's back
  assertEquals(w.store.jobs.length, 0);
});

Deno.test("handlers adapt P1's HandlerContext: news uses the run's market provider, research runs a bounded step", async () => {
  const w = makeWorld({ security: SEC_1 });
  const p2 = registerP2(w.deps);
  const news = await p2.handlers.news(
    ctxFor("news", "news:sec-1", {
      security_id: "sec-1",
      scan_run_id: "run-1",
      scan_date_local: "2026-10-15",
    }),
  );
  assertEquals(news["yahoo"], 1);
  const step = await p2.handlers.research(
    ctxFor("research", "research:sec-1:new_discount:plan", {
      security_id: "sec-1",
      trigger: "new_discount",
      scan_date_local: "2026-10-15",
    }),
  );
  assertEquals(step["kind"], "next");
  assertEquals(
    w.store.jobs.some((j) => j.key.endsWith(":prefetch")),
    true,
  );
});

Deno.test("registerP2 attaches the change check and its seeder only when a monitor store is given", () => {
  const without = makeWorld();
  registerP2(without.deps);
  assertEquals([without.deps.changeCheck, without.deps.seedExtras], [undefined, undefined]);
  const w = makeWorld();
  registerP2(w.deps, new FakeMonitor());
  assert(typeof w.deps.changeCheck === "function" && typeof w.deps.seedExtras === "function");
});
