import { assertEquals } from "@std/assert";
import { seedNewsStage, seedResearchStage } from "./research_seed.ts";
import { FakeStore } from "./testing/fake_store.ts";

const NOW = new Date("2026-10-16T08:00:00Z");
const deps = (store: FakeStore, extras?: () => Promise<number>) => ({
  store,
  now: () => NOW,
  log: async () => {},
  settings: async () => ({
    max_full_reports_per_day: 4,
    tavily_daily_cap: 32,
    tavily_monthly_budget: 950,
    llm_daily_request_cap: 300,
    max_change_checks_per_day: 40,
    reuse_days: 30,
    tavily_reserved_for_reports: 24,
    min_recheck_hours: 72,
    ai_weekdays_only: true,
    visitor_scans_per_hour_per_ip: 3,
    visitor_scans_per_day: 8,
    visitor_retry_minutes: 60,
    busy_retry_minutes: 15,
  }),
  seedExtras: extras,
});

Deno.test("seedResearchStage resumes deferred monitored-holding reports and seeds no new discount, premium or refresh research", async () => {
  const store = new FakeStore();
  const card = (id: number, sid: string) =>
    store.cards.push({
      id,
      scanRunId: "run-2",
      mode: "worldwide",
      securityId: sid,
      rank: id,
      symbol: sid,
      researchReportId: null,
      operationalCategory: "pending",
    });
  card(1, "s1");
  card(2, "s2");
  const running = await store.createReport({
    idempotencyKey: "k2",
    securityId: "s2",
    companyId: "c",
    scanRunId: "run-1",
    trigger: "monitor_change",
    visibility: "holders",
  });
  await store.patchReport(running.id, {
    status: "quota_deferred",
    step: "extract:2",
    notBefore: "2026-10-16T00:05:00.000Z",
  });
  const later = await store.createReport({
    idempotencyKey: "k3",
    securityId: "s3",
    companyId: "c",
    scanRunId: "run-1",
    trigger: "monitor_first",
    visibility: "holders",
  });
  await store.patchReport(later.id, {
    status: "quota_deferred",
    step: "plan",
    notBefore: "2026-10-17T00:05:00.000Z",
  });
  // legacy visitor / manual reports parked before the change are never resumed: a visitor asks again instead
  for (const [n, trigger] of [
    ["v", "visitor"],
    ["m", "manual"],
  ] as const) {
    const parked = await store.createReport({
      idempotencyKey: `k-${n}`,
      securityId: `s-${n}`,
      companyId: "c",
      scanRunId: "run-1",
      trigger,
      visibility: "public",
    });
    await store.patchReport(parked.id, {
      status: "quota_deferred",
      step: "plan",
      notBefore: "2026-10-16T00:05:00.000Z",
    });
  }
  store.premium.set("run-2", ["s4"]);
  const old = await store.createReport({
    idempotencyKey: "k5",
    securityId: "s5",
    companyId: "c",
    scanRunId: "run-0",
    trigger: "new_discount",
    visibility: "public",
  });
  await store.patchReport(old.id, {
    status: "complete",
    isCurrent: true,
    completedAt: "2026-09-01T00:00:00.000Z",
  });

  const count = await seedResearchStage(
    deps(store, async () => 2),
    "run-2",
    "2026-10-16",
  );
  assertEquals(count, 1 + 2, "one resume plus the extras; nothing else is seeded");
  const byKey = (k: string) => store.jobs.find((j) => j.key === k);
  assertEquals(byKey(`research:${running.id}:extract:2:resume:2026-10-16`)?.priority, 40);
  assertEquals(
    byKey(`research:${running.id}:extract:2:resume:2026-10-16`)?.payload.step,
    "extract:2",
  );
  assertEquals(byKey(`research:${later.id}:plan:resume:2026-10-16`), undefined, "not due yet");
  assertEquals(byKey("research:s1:new_discount:plan"), undefined);
  assertEquals(byKey("research:s4:premium:plan"), undefined);
  assertEquals(byKey("research:s5:refresh:plan"), undefined);
  assertEquals(store.jobs.length, 1);
  const before = store.jobs.length;
  await seedResearchStage(deps(store), "run-2", "2026-10-16");
  assertEquals(store.jobs.length, before, "seeding twice adds no job");
});

Deno.test("seedNewsStage seeds one news job per card security", async () => {
  const store = new FakeStore();
  for (const [id, sid] of [
    [1, "s1"],
    [2, "s2"],
    [3, "s1"],
  ] as const) {
    store.cards.push({
      id,
      scanRunId: "run-2",
      mode: id === 3 ? "us" : "worldwide",
      securityId: sid,
      rank: id,
      symbol: sid,
      researchReportId: null,
      operationalCategory: "pending",
    });
  }
  assertEquals(await seedNewsStage(deps(store), "run-2", "2026-10-16"), 2);
  assertEquals(store.jobs.map((j) => j.key).sort(), ["news:s1", "news:s2"]);
});

const pendingCard = (store: FakeStore, id: number, sid: string, mode: "us" | "worldwide") =>
  store.cards.push({
    id,
    scanRunId: "run-3",
    mode,
    securityId: sid,
    rank: id,
    symbol: sid,
    researchReportId: null,
    operationalCategory: "pending",
  });

Deno.test("seedResearchStage seeds nothing for pending cards or premiums", async () => {
  const store = new FakeStore();
  pendingCard(store, 1, "us-only", "us");
  pendingCard(store, 2, "ww-only", "worldwide");
  store.premium.set("run-3", ["us-only"]);
  assertEquals(await seedResearchStage(deps(store), "run-3", "2026-10-16"), 0);
  assertEquals(store.jobs, []);
});

Deno.test("seedResearchStage resets a visitor report parked by the old worker and still resumes a parked monitor_first one", async () => {
  const store = new FakeStore();
  const mk = async (n: string, trigger: "visitor" | "manual" | "monitor_first") => {
    const r = await store.createReport({
      idempotencyKey: `k-${n}`,
      securityId: `s-${n}`,
      companyId: "c",
      scanRunId: "run-1",
      trigger,
      visibility: "public",
    });
    await store.patchReport(r.id, {
      status: "quota_deferred",
      step: "plan",
      notBefore: "2026-10-16T00:05:00.000Z",
    });
    return r;
  };
  const visitor = await mk("v", "visitor");
  const manual = await mk("m", "manual");
  const holding = await mk("h", "monitor_first");
  await store.enqueueJob({
    scanRunId: "run-1",
    stage: "research",
    key: `research:${visitor.id}:plan`,
    priority: 10,
    payload: { report_id: visitor.id },
  });
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const d = {
    ...deps(store),
    log: async (event: string, fields?: unknown) => {
      logs.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
    },
  };

  const count = await seedResearchStage(d, "run-2", "2026-10-16");

  for (const r of [visitor, manual]) {
    const row = store.reports.get(r.id);
    if (!row) throw new Error("missing");
    assertEquals(row.status, "failed");
    assertEquals(row.error, "reset");
    assertEquals(typeof row.completedAt, "string");
  }
  assertEquals(store.reports.get(holding.id)?.status, "quota_deferred");
  assertEquals(count, 1, "only the monitor_first report is resumed");
  assertEquals(
    store.jobs.some((j) => j.payload.report_id === visitor.id),
    false,
  );
  assertEquals(
    store.jobs.some((j) => j.payload.report_id === holding.id),
    true,
  );
  assertEquals(logs.find((l) => l.event === "research_stale_parked_reset")?.fields.count, 2);
});
