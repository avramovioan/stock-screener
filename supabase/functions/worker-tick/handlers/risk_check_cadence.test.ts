import { assert, assertEquals } from "@std/assert";
import type { Filing } from "../../_shared/adapters/fetchers/edgar.ts";
import type { Job } from "../../_shared/adapters/research_types.ts";
import { CHANGE_SYSTEM } from "../../_shared/core/risk.ts";
import { riskCheckHandler, seedChecks } from "./risk_check.ts";
import { FakeMonitor } from "./testing/fake_monitor.ts";
import { makeWorld, scriptedResponder } from "./testing/fakes.ts";

const EIGHT_K: Filing = {
  form: "8-K",
  accession: "0000000001-26-000099",
  filingDate: "2026-10-14",
  primaryDocument: "k8.htm",
  reportDate: null,
};
const MATERIAL = {
  material: true,
  category: "liquidity_debt",
  severity: "material",
  summary: "Going-concern doubt disclosed.",
  evidence_ids: [1],
};
const NOT_MATERIAL = { ...MATERIAL, material: false, category: "other", severity: "watch" };
const SATURDAY = "2026-10-17T08:00:00Z";
const MONDAY_10_SOFIA = "2026-10-19T07:00:00.000Z";

const checkJob = (payload: Record<string, unknown> = {}): Job => ({
  id: 1,
  scan_run_id: "run-1",
  stage: "research",
  key: "research:sec-1:check",
  payload: {
    kind: "change_check",
    security_id: "sec-1",
    scan_date_local: "2026-10-15",
    ...payload,
  },
});
const ctx = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });

function setup(opts: { alternate?: boolean } = {}) {
  const w = makeWorld(opts.alternate ? { alternate: true } : {});
  w.edgar.filings = [EIGHT_K];
  w.deps.sha256 = async (text) => `h:${text}`;
  const monitor = new FakeMonitor();
  const answer = { value: MATERIAL as unknown };
  const inner = scriptedResponder(() => w.verdict.value);
  const responder = (req: Parameters<typeof inner>[0]) =>
    req.system === CHANGE_SYSTEM
      ? {
          ok: true as const,
          usage: { input: 10, output: 5 },
          model: "fake-model",
          json: answer.value,
        }
      : inner(req);
  w.llm.responder = responder;
  if (w.alt) w.alt.responder = responder;
  return { w, monitor, answer, handler: riskCheckHandler(w.deps, monitor) };
}
const outcome = async (h: ReturnType<typeof setup>["handler"], job = checkJob()) =>
  ((await h(job, ctx())) as { outcome: string }).outcome;
const seenAll = { edgar: ["old-1"], rss: ["old-r"], yahoo: ["old-y"] };

Deno.test("the next change check is due min_recheck_hours (72) after this one, not 20", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    lastReportId: "rep-0",
    seen: { edgar: [EIGHT_K.accession], yahoo: [] },
  });
  assertEquals(await outcome(handler), "no_delta");
  assertEquals(monitor.monitorRows[0]?.nextDueAt, "2026-10-18T08:00:00.000Z");
  assertEquals(monitor.monitorRows[0]?.lastCheckAt, w.clock.now.toISOString());
});

Deno.test("the interval is the min_recheck_hours setting", async () => {
  const { w, monitor, handler } = setup();
  w.settings.value = { ...w.settings.value, min_recheck_hours: 36 };
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    lastReportId: "rep-0",
    seen: { edgar: [EIGHT_K.accession], yahoo: [] },
  });
  await handler(checkJob(), ctx());
  assertEquals(monitor.monitorRows[0]?.nextDueAt, "2026-10-16T20:00:00.000Z");
});

Deno.test("a check that runs on a weekend queues itself for Monday 10:00 Sofia and does nothing now", async () => {
  const { w, monitor, handler } = setup();
  w.clock.now = new Date(SATURDAY);
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    lastReportId: "rep-0",
    seen: seenAll,
  });
  assertEquals(await outcome(handler), "waiting");
  assertEquals(w.llm.calls.length + w.tavily.queries.length + w.edgar.calls.length, 0);
  assertEquals(monitor.touched.length, 0);
  const [job] = w.store.jobs;
  assertEquals(w.store.jobs.length, 1);
  assertEquals(job?.notBefore, MONDAY_10_SOFIA);
  assertEquals([job?.payload.kind, job?.payload.late], ["change_check", true]);
  assertEquals(job?.key, `research:sec-1:check:late:${MONDAY_10_SOFIA}`);
});

Deno.test("ai_weekdays_only = false: the weekend check runs", async () => {
  const { w, monitor, handler } = setup();
  w.settings.value = { ...w.settings.value, ai_weekdays_only: false };
  w.clock.now = new Date(SATURDAY);
  monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenAll });
  assertEquals(await outcome(handler), "material");
});

Deno.test("seeder, Thursday: due checks run now as scan jobs, later ones wait for their day", async () => {
  const { w, monitor } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", nextDueAt: "2026-10-14T00:00:00.000Z" });
  monitor.addRow({ userId: "u1", securityId: "sec-2", nextDueAt: "2026-10-17T00:00:00.000Z" });
  assertEquals(await seedChecks(w.deps, monitor)("run-1", "2026-10-15"), 1);
  assertEquals(
    w.store.jobs.map((j) => [j.key, j.notBefore, j.payload.late]),
    [["research:sec-1:check", undefined, undefined]],
  );
});

Deno.test("seeder, Friday: a check that falls due over the weekend is queued now for Monday 10:00", async () => {
  const { w, monitor } = setup();
  w.clock.now = new Date("2026-10-16T07:00:00Z"); // Friday 10:00 Sofia
  monitor.addRow({ userId: "u1", securityId: "sec-1", nextDueAt: "2026-10-15T00:00:00.000Z" }); // due now
  monitor.addRow({ userId: "u1", securityId: "sec-2", nextDueAt: "2026-10-18T08:00:00.000Z" }); // due Sunday
  monitor.addRow({ userId: "u1", securityId: "sec-3", nextDueAt: "2026-10-20T08:00:00.000Z" }); // due Tuesday
  assertEquals(await seedChecks(w.deps, monitor)("run-1", "2026-10-16"), 2);
  const byKey = new Map(w.store.jobs.map((j) => [j.payload.security_id, j]));
  assertEquals(byKey.get("sec-1")?.notBefore, undefined);
  assertEquals(byKey.get("sec-1")?.payload.late, undefined);
  assertEquals(byKey.get("sec-2")?.notBefore, MONDAY_10_SOFIA);
  assertEquals(byKey.get("sec-2")?.payload.late, true);
  assertEquals(byKey.has("sec-3"), false);
});

Deno.test("seeder, Saturday: everything due waits for Monday 10:00 as a side-channel job; reseeding does not duplicate it", async () => {
  const { w, monitor } = setup();
  w.clock.now = new Date(SATURDAY);
  monitor.addRow({ userId: "u1", securityId: "sec-1", nextDueAt: null });
  const seed = seedChecks(w.deps, monitor);
  assertEquals(await seed("run-1", "2026-10-17"), 1);
  await seed("run-1", "2026-10-17");
  assertEquals(w.store.jobs.length, 1);
  assertEquals(w.store.jobs[0]?.notBefore, MONDAY_10_SOFIA);
  assertEquals(w.store.jobs[0]?.payload.late, true);
});

// ---------------------------------------------------------------- persisting discounts (no holders)

Deno.test("seeder: a persisting discount nobody holds gets no card change check", async () => {
  const { w, monitor } = setup();
  w.store.persisting.add("sec-1");
  monitor.watches.set("sec-1", {
    reportId: "rep-0",
    seen: seenAll,
    lastCheckAt: "2026-10-12T08:00:00.000Z",
    nextDueAt: "2026-10-15T08:00:00.000Z",
  });
  w.store.persisting.add("sec-2");
  monitor.watches.set("sec-2", { reportId: "rep-9", seen: {}, lastCheckAt: null, nextDueAt: null });
  assertEquals(await seedChecks(w.deps, monitor)("run-1", "2026-10-15"), 0);
  assertEquals(w.store.jobs, []);
});

Deno.test("seeder: a held persisting discount is checked once, through its monitor row", async () => {
  const { w, monitor } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", nextDueAt: null });
  w.store.persisting.add("sec-1");
  monitor.watches.set("sec-1", { reportId: "rep-0", seen: {}, lastCheckAt: null, nextDueAt: null });
  assertEquals(await seedChecks(w.deps, monitor)("run-1", "2026-10-15"), 1);
});

Deno.test("watch check: first observation is a baseline stored on the report, 72 hours ahead", async () => {
  const { w, monitor, handler } = setup();
  monitor.watches.set("sec-1", { reportId: "rep-0", seen: {}, lastCheckAt: null, nextDueAt: null });
  assertEquals(await outcome(handler), "baseline");
  assertEquals(monitor.watchTouched.length, 1);
  assertEquals(monitor.watchTouched[0]?.reportId, "rep-0");
  assertEquals(monitor.watchTouched[0]?.nextDueAt, "2026-10-18T08:00:00.000Z");
  assertEquals(monitor.watches.get("sec-1")?.seen.edgar, [EIGHT_K.accession]);
  assertEquals(w.llm.calls.length, 0);
});

Deno.test("watch check: no news means no search and no model call", async () => {
  const { w, monitor, handler } = setup();
  monitor.watches.set("sec-1", {
    reportId: "rep-0",
    seen: { edgar: [EIGHT_K.accession], yahoo: [] },
    lastCheckAt: null,
    nextDueAt: null,
  });
  assertEquals(await outcome(handler), "no_delta");
  assertEquals(w.llm.calls.length + w.tavily.queries.length, 0);
  assertEquals(monitor.watchTouched.length, 1);
});

Deno.test("watch check: material news queues one monitor_change report and records no finding (nobody to tell)", async () => {
  const { w, monitor, handler } = setup();
  monitor.watches.set("sec-1", {
    reportId: "rep-0",
    seen: seenAll,
    lastCheckAt: null,
    nextDueAt: null,
  });
  assertEquals(await outcome(handler), "material");
  assertEquals(monitor.findings.length, 0);
  assertEquals(
    w.store.jobs.map((j) => [j.key, j.payload.trigger]),
    [["research:sec-1:monitor_change:plan", "monitor_change"]],
  );
  assert(monitor.watches.get("sec-1")?.seen.edgar?.includes(EIGHT_K.accession));
});

Deno.test("watch check: no second monitor_change while a report is already in flight", async () => {
  const { w, monitor, handler } = setup();
  monitor.watches.set("sec-1", {
    reportId: "rep-0",
    seen: seenAll,
    lastCheckAt: null,
    nextDueAt: null,
  });
  const inflight = await w.store.createReport({
    idempotencyKey: "k",
    securityId: "sec-1",
    companyId: "co-1",
    scanRunId: "run-1",
    trigger: "monitor_change",
    visibility: "public",
  });
  await w.store.patchReport(inflight.id, { status: "running" });
  assertEquals(await outcome(handler), "material");
  assertEquals(w.store.jobs.length, 0);
});

Deno.test("watch check: a security with neither holders nor a watch is skipped", async () => {
  const { handler } = setup();
  assertEquals(await outcome(handler), "skipped");
});

Deno.test("a material check run as a side-channel job queues its report as a side-channel job too", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenAll });
  await handler(checkJob({ late: true }), ctx());
  assertEquals(w.store.jobs.length, 1);
  assertEquals(w.store.jobs[0]?.payload.late, true);
});

// ---------------------------------------------------------------- provider overload during a check

Deno.test("an overloaded primary hands the check to the alternate", async () => {
  const { w, monitor, handler } = setup({ alternate: true });
  w.llm.responder = () => ({ ok: false, kind: "unavailable", status: 503, message: "high demand" });
  monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenAll });
  assertEquals(await outcome(handler), "material");
  assertEquals([w.llm.calls.length, w.alt?.calls.length], [1, 1]);
});

Deno.test("with every provider overloaded the check is left unacknowledged for the next due time", async () => {
  const { w, monitor, handler } = setup();
  w.llm.responder = () => ({ ok: false, kind: "unavailable", status: 503, message: "high demand" });
  monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenAll });
  assertEquals(await outcome(handler), "deferred_provider");
  assertEquals(monitor.monitorRows[0]?.seen, seenAll);
  assertEquals(monitor.touched.length, 0);
});

Deno.test("not material: the news is acknowledged and the next check is 72 hours away", async () => {
  const { monitor, answer, handler } = setup();
  answer.value = NOT_MATERIAL;
  monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenAll });
  assertEquals(await outcome(handler), "not_material");
  assertEquals(monitor.monitorRows[0]?.nextDueAt, "2026-10-18T08:00:00.000Z");
});
