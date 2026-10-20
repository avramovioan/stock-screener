import { assert, assertEquals } from "@std/assert";
import { seedResearchStage } from "./research_seed.ts";
import { makeWorld, planJob, type World } from "./testing/fakes.ts";

const SATURDAY = "2026-10-17T08:00:00Z"; // 11:00 Sofia
const MONDAY_10_SOFIA = "2026-10-19T07:00:00.000Z"; // 10:00 EEST

const reportOf = (w: World) => {
  const all = [...w.store.reports.values()];
  assertEquals(all.length, 1);
  return all[0] as NonNullable<(typeof all)[number]>;
};
const queued = (w: World) => w.store.jobs.filter((j) => j.status === "queued");
const noAiWork = (w: World) =>
  w.llm.calls.length +
  w.tavily.queries.length +
  w.fetch.directCalls.length +
  w.fetch.jinaCalls.length;

async function addCurrent(w: World, completedAt: string, key = "old-key") {
  const current = await w.store.createReport({
    idempotencyKey: key,
    securityId: "sec-1",
    companyId: "co-1",
    scanRunId: "old",
    trigger: "new_discount",
    visibility: "public",
  });
  await w.store.patchReport(current.id, {
    status: "complete",
    isCurrent: true,
    completedAt,
    conclusion: "Meets these two fundamental checks.",
    bankruptcyRisk: "Low",
    materialDamageEstablished: false,
    sufficientEvidence: true,
    summary: "Earlier summary.",
  });
  return current;
}

Deno.test("a new discount found on Saturday waits for Monday 10:00 Sofia: no AI work, pending card, wait fields", async () => {
  const w = makeWorld();
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.step, r.waitReason], ["queued", "plan", "weekend"]);
  assertEquals(
    [r.lastAttemptAt, r.nextAttemptAt, r.notBefore],
    [null, MONDAY_10_SOFIA, MONDAY_10_SOFIA],
  );
  assertEquals(r.nextProvider, "fake-model");
  assertEquals(noAiWork(w), 0);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");
  const [job] = queued(w);
  assertEquals(queued(w).length, 1);
  assertEquals(job?.notBefore, MONDAY_10_SOFIA);
  assertEquals(job?.payload.late, true, "a side-channel job: it never keeps the scan run open");
  assertEquals(job?.payload.report_id, r.id);
  assertEquals(await w.drain(), 0, "not due yet");
});

Deno.test("the weekend job runs on Monday and the whole chain stays a side-channel chain; wait fields clear", async () => {
  const w = makeWorld();
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob());
  w.clock.now = new Date(MONDAY_10_SOFIA);
  await w.drain();
  const r = reportOf(w);
  assertEquals(r.status, "complete");
  assertEquals(
    [r.waitReason, r.lastAttemptAt, r.nextAttemptAt, r.nextProvider],
    [null, null, null, null],
  );
  assertEquals(w.store.cards[0]?.operationalCategory, "green");
  assert(w.store.jobs.length > 10);
  assert(
    w.store.jobs.slice(1).every((j) => j.payload.late === true), // the first job is the scan's own
    "every follow-up job of the chain carries late",
  );
});

Deno.test("Sunday also waits, until the same Monday 10:00", async () => {
  const w = makeWorld();
  w.clock.now = new Date("2026-10-18T19:00:00Z"); // Sunday 22:00 Sofia
  await w.run(planJob());
  assertEquals(reportOf(w).nextAttemptAt, MONDAY_10_SOFIA);
});

Deno.test("DST: Saturday 2026-10-24 waits for Monday 10:00 EET (08:00Z), not 07:00Z", async () => {
  const w = makeWorld();
  w.clock.now = new Date("2026-10-24T09:00:00Z");
  await w.run(planJob());
  assertEquals(reportOf(w).nextAttemptAt, "2026-10-26T08:00:00.000Z");
});

Deno.test("Friday 23:59 Sofia still runs; Saturday 00:00 Sofia waits", async () => {
  const friday = makeWorld();
  friday.clock.now = new Date("2026-10-16T20:59:00Z");
  await friday.run(planJob(), undefined, 1);
  assertEquals(reportOf(friday).status, "running");
  const saturday = makeWorld();
  saturday.clock.now = new Date("2026-10-16T21:00:00Z");
  await saturday.run(planJob());
  assertEquals(reportOf(saturday).waitReason, "weekend");
});

Deno.test("ai_weekdays_only = false lets the weekend run", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, ai_weekdays_only: false };
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob());
  assertEquals(reportOf(w).status, "complete");
});

Deno.test("a manual research_now is exempt from the weekend rule", async () => {
  const w = makeWorld();
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob({}, "sec-1", "manual"));
  assertEquals(reportOf(w).status, "complete");
});

Deno.test("a visitor request is exempt from the weekend rule and the 72 hour rule", async () => {
  const w = makeWorld();
  w.clock.now = new Date(SATURDAY);
  const current = await addCurrent(w, "2026-10-16T08:00:00.000Z"); // finished a day ago
  await w.run(planJob({}, "sec-1", "visitor"));
  const fresh = [...w.store.reports.values()].filter((r) => r.id !== current.id);
  assertEquals(fresh.length, 1);
  assertEquals([fresh[0]?.trigger, fresh[0]?.status], ["visitor", "complete"]);
});

Deno.test("a visitor report records usage.source from the payload and is public for a discount card", async () => {
  const w = makeWorld();
  await w.run(planJob({ source: "visitor" }, "sec-1", "visitor"));
  const r = reportOf(w);
  assertEquals(
    [r.trigger, r.status, r.visibility, r.usage.source],
    ["visitor", "complete", "public", "visitor"],
  );
});

Deno.test("a visitor request never reuses a fresh report", async () => {
  const w = makeWorld();
  const current = await addCurrent(w, "2026-10-10T08:00:00.000Z");
  await w.run(planJob({}, "sec-1", "visitor"));
  assertEquals(w.store.reports.size, 2);
  assert(w.llm.calls.length > 0);
  assert([...w.store.reports.values()].some((r) => r.id !== current.id && r.status === "complete"));
});

Deno.test("a reusable report on a weekend is still linked: reuse is no AI call", async () => {
  const w = makeWorld();
  const current = await addCurrent(w, "2026-10-10T08:00:00.000Z");
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob());
  assertEquals(w.store.cards[0]?.researchReportId, current.id);
  assertEquals(noAiWork(w), 0);
  assertEquals(w.store.reports.size, 1);
});

Deno.test("a chain that crosses into Saturday pauses before its next model call and resumes on Monday", async () => {
  const w = makeWorld();
  w.clock.now = new Date("2026-10-16T20:50:00Z"); // Friday 23:50 Sofia
  await w.run(planJob(), undefined, 7); // plan ... fetch:3
  assertEquals(reportOf(w).step, "fetch:3");
  assertEquals(w.llm.calls.length, 0);
  w.clock.now = new Date("2026-10-16T21:05:00Z"); // Saturday 00:05 Sofia
  await w.drain();
  let r = reportOf(w);
  assertEquals([r.status, r.step, r.waitReason], ["queued", "extract:1", "weekend"]);
  assertEquals(r.nextAttemptAt, MONDAY_10_SOFIA);
  assertEquals(w.llm.calls.length, 0, "no AI call on the weekend");
  w.clock.now = new Date(MONDAY_10_SOFIA);
  await w.drain();
  r = reportOf(w);
  assertEquals([r.status, r.waitReason], ["complete", null]);
});

Deno.test("a recent report delays an AI re-run by 72 hours (cadence_72h) and says when it was last checked", async () => {
  const w = makeWorld();
  const completed = "2026-10-12T08:00:00.000Z"; // Monday
  await addCurrent(w, completed);
  w.clock.now = new Date("2026-10-13T08:00:00Z");
  await w.run(planJob({}, "sec-1", "refresh"));
  const waiting = [...w.store.reports.values()].find((r) => r.trigger === "refresh");
  assertEquals(
    [waiting?.status, waiting?.waitReason, waiting?.lastAttemptAt, waiting?.nextAttemptAt],
    ["queued", "cadence_72h", completed, "2026-10-15T08:00:00.000Z"],
  );
  assertEquals(noAiWork(w), 0);
  w.clock.now = new Date("2026-10-15T08:00:00Z");
  await w.drain();
  assertEquals(
    [...w.store.reports.values()].find((r) => r.trigger === "refresh")?.status,
    "complete",
  );
});

Deno.test("a 72 hour due time that lands on Saturday moves to Monday 10:00", async () => {
  const w = makeWorld();
  await addCurrent(w, "2026-10-14T08:00:00.000Z");
  w.clock.now = new Date("2026-10-15T08:00:00Z"); // Thursday
  await w.run(planJob({}, "sec-1", "refresh"));
  const waiting = [...w.store.reports.values()].find((r) => r.trigger === "refresh");
  assertEquals([waiting?.waitReason, waiting?.nextAttemptAt], ["cadence_72h", MONDAY_10_SOFIA]);
});

Deno.test("min_recheck_hours is a setting: 24 hours lets the next day through", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, min_recheck_hours: 24 };
  await addCurrent(w, "2026-10-14T08:00:00.000Z");
  w.clock.now = new Date("2026-10-15T08:00:00Z");
  await w.run(planJob({}, "sec-1", "refresh"));
  assertEquals(
    [...w.store.reports.values()].find((r) => r.trigger === "refresh")?.status,
    "complete",
  );
});

Deno.test("monitor_change (a material finding just found) is exempt from the 72 hour rule", async () => {
  const w = makeWorld();
  await addCurrent(w, "2026-10-14T08:00:00.000Z");
  w.clock.now = new Date("2026-10-15T08:00:00Z");
  await w.run(planJob({}, "sec-1", "monitor_change"));
  assertEquals(
    [...w.store.reports.values()].find((r) => r.trigger === "monitor_change")?.status,
    "complete",
  );
});

Deno.test("a brand-new discount with no report is not blocked by the 72 hour rule", async () => {
  const w = makeWorld();
  w.clock.now = new Date("2026-10-15T08:00:00Z");
  await w.run(planJob());
  assertEquals(reportOf(w).status, "complete");
});

Deno.test("a waiting report counts as in flight: the next scan does not queue a second report for it", async () => {
  const w = makeWorld();
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob());
  w.store.scanRuns.push({ id: "run-2", scanDateLocal: "2026-10-20" });
  w.store.cards.push({
    id: 2,
    scanRunId: "run-2",
    mode: "worldwide",
    securityId: "sec-1",
    rank: 1,
    symbol: "ACME",
    researchReportId: null,
    operationalCategory: "pending",
  });
  w.clock.now = new Date("2026-10-20T08:00:00Z");
  assertEquals(await seedResearchStage(w.deps, "run-2", "2026-10-20"), 0);
});

Deno.test("late research also updates the cards of a newer scan run, with no second digest step", async () => {
  const w = makeWorld();
  w.clock.now = new Date(SATURDAY);
  await w.run(planJob());
  w.store.scanRuns.push({ id: "run-2", scanDateLocal: "2026-10-19" });
  w.store.cards.push({
    id: 2,
    scanRunId: "run-2",
    mode: "us",
    securityId: "sec-1",
    rank: 1,
    symbol: "ACME",
    researchReportId: null,
    operationalCategory: "pending",
  });
  w.clock.now = new Date(MONDAY_10_SOFIA);
  await w.drain();
  const report = reportOf(w);
  assertEquals(report.status, "complete");
  assertEquals(
    w.store.cards.map((c) => [c.id, c.operationalCategory, c.researchReportId]),
    [
      [1, "green", report.id],
      [2, "green", report.id],
    ],
  );
});
