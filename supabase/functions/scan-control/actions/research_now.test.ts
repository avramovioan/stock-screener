import { assert, assertEquals } from "@std/assert";
import { makeWorld, SEC_1 } from "../../worker-tick/handlers/testing/fakes.ts";
import { requestVisitorResearch, researchNow } from "./research_now.ts";

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Deno.test("research_now: validates input, queues one manual job, is idempotent per day", async () => {
  const w = makeWorld({ security: { ...SEC_1, securityId: SID } });
  assertEquals((await researchNow({ store: w.store }, { security_id: "not valid!" })).ok, false);
  assertEquals(await researchNow({ store: w.store }, { security_id: "sec-1" }), {
    ok: false,
    error: "invalid_input",
  });
  assertEquals(
    await researchNow({ store: w.store }, { security_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    {
      ok: false,
      error: "unknown_security",
    },
  );
  const first = await researchNow({ store: w.store }, { security_id: SID });
  assert(first.ok);
  assertEquals(first.job_key, `research:${SID}:manual:plan`);
  const job = w.store.jobs.find((j) => j.key === first.job_key);
  assertEquals(
    [job?.priority, job?.payload.trigger, job?.payload.scan_date_local],
    [5, "manual", "2026-10-15"],
  );
  await w.drain();
  const report = [...w.store.reports.values()][0];
  assertEquals([report?.trigger, report?.status], ["manual", "complete"]);
  const second = await researchNow({ store: w.store }, { security_id: SID });
  assert(second.ok);
  assertEquals(second.existing_report_id, report?.id);
  assertEquals(
    w.store.jobs.filter((j) => j.key === `research:${SID}:manual:plan`).length,
    1,
    "no second job",
  );
});

Deno.test("research_now: no scan run yet", async () => {
  const w = makeWorld({ security: { ...SEC_1, securityId: SID } });
  w.store.scanRuns.length = 0;
  assertEquals(await researchNow({ store: w.store }, { security_id: SID }), {
    ok: false,
    error: "no_scan_run",
  });
});

Deno.test("requestVisitorResearch: queues one visitor job on the latest published run, keyed by the accepted minute", async () => {
  const w = makeWorld({ security: { ...SEC_1, securityId: SID } });
  w.store.scanRuns.push({ id: "run-9", scanDateLocal: "2026-10-16" });
  w.store.publishedRunId = "run-1";
  const now = () => w.clock.now;
  const res = await requestVisitorResearch({ store: w.store, now }, { security_id: SID });
  assert(res.ok);
  const minute = `${w.clock.now.toISOString().slice(0, 16)}:00.000Z`;
  assertEquals(res.job_key, `research:${SID}:visitor:plan:${minute}`);
  assertEquals(res.scan_run_id, "run-1");
  assertEquals(res.started_at, w.clock.now.toISOString());
  const job = w.store.jobs.find((j) => j.key === res.job_key);
  assertEquals(
    [job?.scanRunId, job?.priority, job?.payload.trigger, job?.payload.source],
    ["run-1", 5, "visitor", "visitor"],
  );
  await w.drain();
  const report = [...w.store.reports.values()][0];
  assertEquals(
    [report?.trigger, report?.status, report?.usage.source],
    ["visitor", "complete", "visitor"],
  );
  assertEquals(report?.idempotencyKey, `${SID}:visitor:${minute}`);
});

Deno.test("requestVisitorResearch: a failed report never blocks the next request; no published run is refused", async () => {
  const w = makeWorld({ security: { ...SEC_1, securityId: SID } });
  w.store.publishedRunId = "run-1";
  const at = (iso: string) => ({ store: w.store, now: () => new Date(iso) });
  const first = await requestVisitorResearch(at("2026-10-15T09:00:10Z"), { security_id: SID });
  // the first scan failed: its report is failed and its job is done, so the company is free again
  for (const r of w.store.reports.values()) r.status = "failed";
  for (const j of w.store.jobs) j.status = "done";
  const second = await requestVisitorResearch(at("2026-10-15T09:01:10Z"), { security_id: SID });
  assert(first.ok && second.ok);
  assert(first.job_key !== second.job_key);
  w.store.publishedRunId = null;
  assertEquals(await requestVisitorResearch(at("2026-10-15T09:02:00Z"), { security_id: SID }), {
    ok: false,
    error: "no_scan_run",
  });
  assertEquals(await requestVisitorResearch(at("2026-10-15T09:02:00Z"), { security_id: "x" }), {
    ok: false,
    error: "invalid_input",
  });
});

Deno.test("requestVisitorResearch: creates the queued report with the job and answers its id; the worker reuses that row", async () => {
  const w = makeWorld({ security: { ...SEC_1, securityId: SID } });
  w.store.publishedRunId = "run-1";
  const res = await requestVisitorResearch(
    { store: w.store, now: () => w.clock.now },
    { security_id: SID },
  );
  assert(res.ok);
  const queued = [...w.store.reports.values()];
  assertEquals(queued.length, 1);
  assertEquals(res.report_id, queued[0]?.id);
  assertEquals([queued[0]?.status, queued[0]?.trigger], ["queued", "visitor"]);
  await w.drain();
  const after = [...w.store.reports.values()];
  assertEquals(after.length, 1, "the worker did not create a second report");
  assertEquals([after[0]?.id, after[0]?.status], [res.report_id, "complete"]);
});

Deno.test("requestVisitorResearch: a second request while the first is open is in_flight with the first one's start", async () => {
  const w = makeWorld({ security: { ...SEC_1, securityId: SID } });
  w.store.publishedRunId = "run-1";
  const first = await requestVisitorResearch(
    { store: w.store, now: () => w.clock.now },
    { security_id: SID },
  );
  assert(first.ok);
  const second = await requestVisitorResearch(
    { store: w.store, now: () => new Date(w.clock.now.getTime() + 30_000) },
    { security_id: SID },
  );
  assertEquals(second, {
    ok: false,
    error: "in_flight",
    started_at: first.started_at,
    requested_by: "visitor",
  });
  assertEquals(w.store.jobs.length, 1);
  assertEquals(w.store.reports.size, 1);
});
