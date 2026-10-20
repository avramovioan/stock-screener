import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { GenerateJsonResult } from "../../_shared/adapters/llm/types.ts";
import { seedResearchStage } from "./research_seed.ts";
import { nextQuotaReset } from "./research_steps.ts";
import {
  FakeLlm,
  makeWorld,
  planJob,
  SEC_1,
  scriptedResponder,
  type World,
} from "./testing/fakes.ts";

const unavailable = (): GenerateJsonResult<unknown> => ({
  ok: false,
  kind: "unavailable",
  status: 503,
  message: "This model is currently experiencing high demand.",
});
const rateLimited = (): GenerateJsonResult<unknown> => ({
  ok: false,
  kind: "rate_limited",
  status: 429,
  message: "per minute",
});
const quota = (): GenerateJsonResult<unknown> => ({
  ok: false,
  kind: "quota",
  status: 429,
  message: "daily quota",
});

const reportOf = (w: World) => {
  const all = [...w.store.reports.values()];
  assertEquals(all.length, 1);
  return all[0] as NonNullable<(typeof all)[number]>;
};
const queued = (w: World) => w.store.jobs.filter((j) => j.status === "queued");
const inMinutes = (w: World, n: number) =>
  new Date(w.clock.now.getTime() + n * 60_000).toISOString();
const advance = (w: World, ms: number) => {
  w.clock.now = new Date(w.clock.now.getTime() + ms);
};

Deno.test("overload on the primary: the step is retried at once on the alternate, which writes the report", async () => {
  const w = makeWorld({ alternate: true });
  w.llm.responder = unavailable;
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals(r.status, "complete");
  assertEquals([r.provider, r.model], ["mistral", "mistral-large-latest"]);
  assertEquals(r.fallbackReason, "primary_unavailable");
  assertEquals(
    [r.waitReason, r.lastAttemptAt, r.nextAttemptAt, r.nextProvider],
    [null, null, null, null],
  );
  assertEquals(w.llm.calls.length, 1, "the overloaded primary is not asked again");
  assertEquals(w.alt?.calls.length, 9, "8 extractions (the first included) and the synthesis");
  assertEquals(w.store.quota.get("mistral|llm_requests|day"), 9);
  assertEquals(w.store.quota.get("gemini|llm_requests|day"), 1);
  assertEquals(w.store.cards[0]?.operationalCategory, "green");
  assertEquals(r.usage.step_providers?.["extract:1"], "mistral");
  assertEquals(r.usage.step_providers?.synthesize, "mistral");
  assertEquals(r.usage.unavailable_retries ?? 0, 0, "no backoff was needed");
});

Deno.test("overload only at the synthesis: extraction by the primary, the report text by the alternate", async () => {
  const w = makeWorld({ alternate: true });
  const answer = w.llm.responder;
  w.llm.responder = (req) => (req.schemaName === "research_output" ? unavailable() : answer(req));
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals(
    [r.status, r.provider, r.fallbackReason],
    ["complete", "mistral", "primary_unavailable"],
  );
  assertEquals(r.usage.step_providers?.["extract:1"], "gemini");
  assertEquals(r.usage.step_providers?.synthesize, "mistral");
  assertEquals(w.alt?.calls.length, 1);
});

Deno.test("overload with no alternate: backoff 3, 10, 30, 60 minutes without consuming a job attempt", async () => {
  const w = makeWorld();
  w.llm.responder = unavailable;
  const t0 = w.clock.now.toISOString();
  await w.run(planJob({}, "sec-1", "monitor_first")); // must not throw: a throw would burn a job attempt
  let r = reportOf(w);
  assertEquals([r.status, r.step], ["running", "extract:1"]);
  assertEquals(
    [r.waitReason, r.lastAttemptAt, r.nextAttemptAt, r.nextProvider],
    ["provider_unavailable", t0, inMinutes(w, 3), "fake-model"],
  );
  assertEquals(r.usage.unavailable_retries, 1);
  assertEquals(r.usage.rate_limit_retries ?? 0, 0, "separate from the rate limit retries");
  assertEquals(queued(w).length, 1);
  assertEquals(queued(w)[0]?.notBefore, inMinutes(w, 3));
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");

  const waits = [3, 10, 30, 60];
  for (let i = 1; i < waits.length; i++) {
    advance(w, (waits[i - 1] ?? 0) * 60_000);
    const attemptAt = w.clock.now.toISOString();
    await w.drain();
    r = reportOf(w);
    assertEquals(r.waitReason, "provider_unavailable");
    assertEquals([r.lastAttemptAt, r.nextAttemptAt], [attemptAt, inMinutes(w, waits[i] ?? 0)]);
    assertEquals(r.usage.unavailable_retries, i + 1);
  }
});

async function exhaust(w: World): Promise<void> {
  await w.run(planJob({}, "sec-1", "monitor_first"));
  for (const delay of [3, 10, 30, 60]) {
    advance(w, delay * 60_000);
    await w.drain();
  }
}

Deno.test("overload past the fourth retry defers to the next scan day as provider_unavailable (not failed, not dead)", async () => {
  const w = makeWorld();
  w.llm.responder = unavailable;
  await exhaust(w);
  const r = reportOf(w);
  assertEquals(
    [r.status, r.error, r.step],
    ["quota_deferred", "provider_unavailable", "extract:1"],
  );
  assertEquals(r.waitReason, "provider_unavailable");
  assertEquals(r.notBefore, "2026-10-16T00:05:00.000Z");
  assertEquals(r.nextAttemptAt, "2026-10-16T00:05:00.000Z");
  assertEquals(r.usage.unavailable_retries, 4, "bounded at four");
  assertEquals(queued(w).length, 0, "nothing is retried the same day");
  assertEquals(
    [w.store.cards[0]?.operationalCategory, w.store.cards[0]?.categoryReason],
    ["pending", "research_quota_deferred"],
  );
});

Deno.test("the deferred report resumes at the next scan and completes; its wait fields are cleared", async () => {
  const w = makeWorld();
  w.llm.responder = unavailable;
  await exhaust(w);
  const deferred = reportOf(w);
  // only a monitored holding is parked and resumed (a discount report is not resumed)
  await w.store.patchReport(deferred.id, { trigger: "monitor_first" });
  w.llm.responder = scriptedResponder(() => "green");
  w.clock.now = new Date("2026-10-16T08:00:00Z");
  w.store.scanRuns.push({ id: "run-2", scanDateLocal: "2026-10-16" });
  assertEquals(await seedResearchStage(w.deps, "run-2", "2026-10-16"), 1);
  await w.drain();
  const r = reportOf(w);
  assertEquals([r.id, r.status], [deferred.id, "complete"]);
  assertEquals(
    [r.waitReason, r.lastAttemptAt, r.nextAttemptAt, r.nextProvider],
    [null, null, null, null],
  );
});

Deno.test("both providers unavailable: each attempt tries both, then the same bounded backoff", async () => {
  const w = makeWorld({ alternate: true });
  w.llm.responder = unavailable;
  if (w.alt) w.alt.responder = unavailable;
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const r = reportOf(w);
  assertEquals(
    [r.status, r.waitReason, r.usage.unavailable_retries],
    ["running", "provider_unavailable", 1],
  );
  assertEquals([w.llm.calls.length, w.alt?.calls.length], [1, 1]);
  assertEquals(r.nextAttemptAt, inMinutes(w, 3));
  for (const delay of [3, 10, 30, 60]) {
    advance(w, delay * 60_000);
    await w.drain();
  }
  const done = reportOf(w);
  assertEquals([done.status, done.error], ["quota_deferred", "provider_unavailable"]);
  assertEquals([w.llm.calls.length, w.alt?.calls.length], [5, 5]);
});

Deno.test("an overload that clears during the backoff completes the report on the primary with no fallback reason", async () => {
  const w = makeWorld();
  const answer = w.llm.responder;
  let down = true;
  w.llm.responder = (req) => (down ? unavailable() : answer(req));
  await w.run(planJob({}, "sec-1", "monitor_first"));
  assertEquals(reportOf(w).waitReason, "provider_unavailable");
  down = false;
  advance(w, 3 * 60_000);
  await w.drain();
  const r = reportOf(w);
  assertEquals([r.status, r.provider, r.fallbackReason], ["complete", "gemini", null]);
  assertEquals(
    [r.waitReason, r.lastAttemptAt, r.nextAttemptAt, r.nextProvider],
    [null, null, null, null],
  );
});

Deno.test("a primary near its daily cap at the start hands the new report to the alternate: primary_quota", async () => {
  const w = makeWorld({ alternate: true });
  w.store.quota.set("gemini|llm_requests|day", 280);
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider, r.fallbackReason], ["complete", "mistral", "primary_quota"]);
  assertEquals(w.llm.calls.length, 0);
});

Deno.test("an unconfigured primary is a setup choice, not a fallback: no fallback reason", async () => {
  const w = makeWorld({ configured: false, alternate: true });
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider, r.fallbackReason], ["complete", "mistral", null]);
});

Deno.test("the primary's daily quota answer mid-report switches to the alternate: primary_quota", async () => {
  const w = makeWorld({ alternate: true });
  w.llm.responder = quota;
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider, r.fallbackReason], ["complete", "mistral", "primary_quota"]);
});

Deno.test("repeated per-minute 429s on the primary end on the alternate: primary_rate_limited", async () => {
  const w = makeWorld({ alternate: true });
  w.llm.responder = rateLimited;
  await w.run(planJob());
  let r = reportOf(w);
  assertEquals(r.waitReason, "rate_limited");
  assertEquals(r.nextAttemptAt, new Date(w.clock.now.getTime() + 90_000).toISOString());
  assertEquals(r.nextProvider, "fake-model");
  for (let i = 0; i < 4; i++) {
    advance(w, 121_000);
    await w.drain();
  }
  r = reportOf(w);
  assertEquals(
    [r.status, r.provider, r.fallbackReason],
    ["complete", "mistral", "primary_rate_limited"],
  );
  assertEquals(r.waitReason, null);
  assertEquals(w.llm.calls.length, 4, "one call plus three retries on the primary");
});

Deno.test("without an alternate, repeated 429s still end in the llm_quota deferral with its wait reason", async () => {
  const w = makeWorld();
  w.llm.responder = rateLimited;
  await w.run(planJob({}, "sec-1", "monitor_first"));
  for (let i = 0; i < 4; i++) {
    advance(w, 121_000);
    await w.drain();
  }
  const r = reportOf(w);
  assertEquals([r.status, r.error, r.waitReason], ["quota_deferred", "llm_quota", "llm_quota"]);
  assertNotEquals(r.nextAttemptAt, null);
  assert(r.lastAttemptAt !== null);
});

Deno.test("a Tavily day-long deferral carries the search_quota wait reason", async () => {
  const w = makeWorld({ security: { ...SEC_1, secCik: null } });
  w.edgar.filings = [];
  w.tavily.mode = "quota";
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const r = reportOf(w);
  assertEquals(
    [r.status, r.error, r.waitReason],
    ["quota_deferred", "tavily_quota", "search_quota"],
  );
  assertEquals(r.nextAttemptAt, "2026-10-16T00:05:00.000Z");
});

Deno.test("round trip: primary 503, backup 503, backoff, the step returns to the primary, which writes the report: no fallback reason", async () => {
  const w = makeWorld({ alternate: true });
  const answer = w.llm.responder;
  let primaryCalls = 0;
  w.llm.responder = (req) => (primaryCalls++ === 0 ? unavailable() : answer(req));
  if (w.alt) w.alt.responder = unavailable;
  await w.run(planJob({}, "sec-1", "monitor_first"));
  let r = reportOf(w);
  assertEquals(
    [r.status, r.waitReason, r.provider],
    ["running", "provider_unavailable", "mistral"],
  );
  assertEquals(
    r.fallbackReason,
    "primary_unavailable",
    "while the backup holds the report the reason is shown",
  );
  advance(w, 3 * 60_000);
  await w.drain();
  r = reportOf(w);
  assertEquals(r.status, "complete");
  assertEquals(
    [r.provider, r.model],
    ["gemini", "fake-model"],
    "provider and model name the actual writer",
  );
  assertEquals(
    r.fallbackReason,
    null,
    "the primary wrote it: the card must not claim the backup did",
  );
});

// ------------------------------------------------------------------ the provider chain (N models)

const network = (): GenerateJsonResult<unknown> => ({
  ok: false,
  kind: "network",
  message: "fetch failed",
});

/** A world with a chain of `n` models: gemini (Pacific reset), mistral (Pacific), q3 (UTC), all scripted to answer green. */
function chainWorld(n = 3): World & { models: FakeLlm[] } {
  const w = makeWorld({ alternate: n > 1 });
  const models: FakeLlm[] = [w.llm];
  if (w.alt) models.push(w.alt);
  while (models.length < n) {
    const m = new FakeLlm(
      `q${models.length + 1}`,
      `model-${models.length + 1}`,
      true,
      scriptedResponder(() => w.verdict.value),
    );
    w.deps.llm[m.name] = m;
    w.deps.llmOrder.push(m.name);
    models.push(m);
  }
  const resets = ["pacific", "pacific", "utc"] as const;
  models.forEach((m, i) => {
    Object.assign(m, { quotaReset: resets[i] ?? "utc" });
  });
  return Object.assign(w, { models });
}
const [P, M, Q] = ["gemini", "mistral", "q3"] as const;
const model = (w: { models: FakeLlm[] }, i: number): FakeLlm => {
  const m = w.models[i];
  if (!m) throw new Error(`no model ${i}`);
  return m;
};
const drainRetries = async (w: World, times: number) => {
  for (let i = 0; i < times; i++) {
    advance(w, 121_000);
    await w.drain();
  }
};
const failedLogs = (w: World) => w.logs.filter((l) => l.event === "research_failed");

Deno.test("chain: the first model that is not exhausted writes the report; the others are not called", async () => {
  const w = chainWorld();
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider], ["complete", P]);
  assertEquals([model(w, 1).calls.length, model(w, 2).calls.length], [0, 0]);
});

Deno.test("chain: exhausted models are read once per step and skipped at the start of a new report", async () => {
  const w = chainWorld();
  w.store.exhausted.set(P, { until: "2026-10-16T07:00:00.000Z", error: "daily" });
  w.store.exhausted.set(M, { until: "2026-10-15T07:59:59.000Z", error: "old, already over" });
  const jobs = await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider, r.fallbackReason], ["complete", M, "primary_quota"]);
  assertEquals(model(w, 0).calls.length, 0);
  assert(w.store.exhaustedReads > 0 && w.store.exhaustedReads <= jobs, "at most one read per job");
});

Deno.test("chain: per-minute limits retry 3 times on a model, then the next one, and never come back", async () => {
  const w = chainWorld();
  model(w, 0).responder = rateLimited;
  model(w, 1).responder = rateLimited;
  await w.run(planJob());
  await drainRetries(w, 9);
  const r = reportOf(w);
  assertEquals([r.status, r.provider], ["complete", Q]);
  assertEquals(model(w, 0).calls.length, 4, "one call plus three retries");
  assertEquals(model(w, 1).calls.length, 4);
  assertEquals(r.fallbackReason, "primary_rate_limited");
});

Deno.test("chain: overload moves on to the next model at once, down the whole chain", async () => {
  const w = chainWorld();
  model(w, 0).responder = unavailable;
  model(w, 1).responder = unavailable;
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider, r.fallbackReason], ["complete", Q, "primary_unavailable"]);
  assertEquals([model(w, 0).calls.length, model(w, 1).calls.length], [1, 1]);
  assertEquals(r.waitReason, null);
  assertEquals(r.usage.unavailable_retries ?? 0, 0);
});

Deno.test("chain: a network failure also moves on at once instead of failing the job", async () => {
  const w = chainWorld();
  model(w, 0).responder = network;
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals([r.status, r.provider], ["complete", M]);
  assertEquals(model(w, 0).calls.length, 1);
});

Deno.test("chain: a per-day quota answer marks the model exhausted until its own reset (Pacific or UTC) and moves on", async () => {
  const w = chainWorld();
  for (const m of w.models) m.responder = quota;
  await w.run(planJob({}, "sec-1", "monitor_first"));
  assertEquals(w.store.exhausted.get(P)?.until, "2026-10-16T07:00:00.000Z", "midnight PDT");
  assertEquals(w.store.exhausted.get(M)?.until, "2026-10-16T07:00:00.000Z");
  assertEquals(w.store.exhausted.get(Q)?.until, "2026-10-16T00:00:00.000Z", "midnight UTC");
  assertEquals(w.store.exhausted.get(P)?.error, "daily quota");
});

Deno.test("chain: a model that answered per-day quota is skipped by the next report", async () => {
  const w = chainWorld();
  const answer = model(w, 0).responder;
  model(w, 0).responder = quota;
  await w.run(planJob());
  assertEquals(reportOf(w).provider, M);
  model(w, 0).responder = answer;
  const before = model(w, 0).calls.length;
  await w.run(planJob({ accepted_at: "2026-10-15T08:10:00Z" }, "sec-1", "visitor"));
  const fresh = [...w.store.reports.values()].find((r) => r.trigger === "visitor");
  assertEquals([fresh?.status, fresh?.provider], ["complete", M]);
  assertEquals(model(w, 0).calls.length, before, "not asked again");
});

Deno.test("nextQuotaReset: next midnight Pacific is DST-safe, next midnight UTC is plain", () => {
  const at = (iso: string, mode: "pacific" | "utc") => nextQuotaReset(new Date(iso), mode);
  assertEquals(at("2026-10-15T08:00:00Z", "pacific"), "2026-10-16T07:00:00.000Z"); // PDT
  assertEquals(at("2026-12-01T10:00:00Z", "pacific"), "2026-12-02T08:00:00.000Z"); // PST
  assertEquals(at("2026-11-01T05:00:00Z", "pacific"), "2026-11-01T07:00:00.000Z"); // fall back day, still PDT
  assertEquals(at("2026-11-01T09:00:00Z", "pacific"), "2026-11-02T08:00:00.000Z"); // after the change: PST
  assertEquals(at("2027-03-14T05:00:00Z", "pacific"), "2027-03-14T08:00:00.000Z"); // before spring forward
  assertEquals(at("2027-03-14T12:00:00Z", "pacific"), "2027-03-15T07:00:00.000Z"); // PDT
  assertEquals(at("2026-10-15T23:59:59Z", "pacific"), "2026-10-16T07:00:00.000Z");
  assertEquals(at("2026-10-16T07:00:00Z", "pacific"), "2026-10-17T07:00:00.000Z"); // exactly at the reset: the next one
  assertEquals(at("2026-10-15T08:00:00Z", "utc"), "2026-10-16T00:00:00.000Z");
  assertEquals(at("2026-12-31T23:59:59Z", "utc"), "2027-01-01T00:00:00.000Z");
});

Deno.test("visitor: every model exhausted for the day fails the report with no_quota, never parks it", async () => {
  const w = chainWorld();
  for (const m of w.models) m.responder = quota;
  await w.run(planJob({ accepted_at: "2026-10-15T08:10:00Z" }, "sec-1", "visitor"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "no_quota"]);
  assertEquals(r.notBefore, null);
  assertEquals(queued(w).length, 0, "nothing parked, no side-channel job");
  assertEquals(failedLogs(w).length, 1);
  assertEquals(failedLogs(w)[0]?.data?.code, "no_quota");
  assertEquals(w.logs.filter((l) => l.event === "research_quota_deferred").length, 0);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending", "the card keeps what it showed");
});

Deno.test("manual: a chain that is exhausted before the plan fails with no_quota", async () => {
  const w = chainWorld();
  for (const m of w.models)
    w.store.exhausted.set(m.name, { until: "2026-10-16T07:00:00.000Z", error: "daily" });
  await w.run(planJob({}, "sec-1", "manual"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "no_quota"]);
  assertEquals(
    w.models.map((m) => m.calls.length),
    [0, 0, 0],
  );
});

Deno.test("visitor: when only overload or limits stopped the chain the report fails with providers_busy", async () => {
  const w = chainWorld();
  for (const m of w.models) m.responder = unavailable;
  await w.run(planJob({ accepted_at: "2026-10-15T08:10:00Z" }, "sec-1", "visitor"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "providers_busy"]);
  assertEquals(queued(w).length, 0, "no backoff retries for a visitor");
  assertEquals(failedLogs(w)[0]?.data?.code, "providers_busy");
});

Deno.test("visitor: a mix of daily quota and overload is providers_busy (not every model is spent)", async () => {
  const w = chainWorld();
  model(w, 0).responder = quota;
  model(w, 1).responder = quota;
  model(w, 2).responder = unavailable;
  await w.run(planJob({}, "sec-1", "visitor"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "providers_busy"]);
  assertEquals(w.store.exhausted.size, 2);
});

Deno.test("visitor: per-minute limits on the whole chain end as providers_busy after the bounded retries", async () => {
  const w = chainWorld(2);
  model(w, 0).responder = rateLimited;
  model(w, 1).responder = rateLimited;
  await w.run(planJob({}, "sec-1", "visitor"));
  await drainRetries(w, 7);
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "providers_busy"]);
  assertEquals(queued(w).length, 0);
});

Deno.test("visitor: Tavily out of credits fails with no_quota instead of parking", async () => {
  const w = chainWorld();
  w.store.securities.set("sec-1", { ...SEC_1, secCik: null });
  w.edgar.filings = [];
  w.tavily.mode = "quota";
  await w.run(planJob({}, "sec-1", "visitor"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "no_quota"]);
  assertEquals(queued(w).length, 0);
});

Deno.test("monitored holdings keep today's behaviour: every model out of quota parks the report", async () => {
  const w = chainWorld();
  for (const m of w.models) m.responder = quota;
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["quota_deferred", "llm_quota"]);
  assertEquals(r.notBefore, "2026-10-16T00:05:00.000Z");
});

Deno.test("monitored holdings keep today's overload backoff across the whole chain", async () => {
  const w = chainWorld();
  for (const m of w.models) m.responder = unavailable;
  await w.run(planJob({}, "sec-1", "monitor_change"));
  const r = reportOf(w);
  assertEquals(
    [r.status, r.waitReason, r.usage.unavailable_retries],
    ["running", "provider_unavailable", 1],
  );
  assertEquals(queued(w).length, 1);
});

Deno.test("a finished report supersedes the older in-flight reports of the same security and their queued jobs", async () => {
  const w = chainWorld(1);
  const mk = async (key: string, sec: string, status: "queued" | "running" | "quota_deferred") => {
    const rep = await w.store.createReport({
      idempotencyKey: key,
      securityId: sec,
      companyId: "co-1",
      scanRunId: "run-1",
      trigger: "visitor",
      visibility: "public",
    });
    await w.store.patchReport(rep.id, { status });
    return rep;
  };
  const a = await mk("old-a", "sec-1", "queued");
  const b = await mk("old-b", "sec-1", "running");
  const c = await mk("old-c", "sec-1", "quota_deferred");
  const other = await mk("other", "sec-2", "running");
  await w.store.enqueueJob({
    scanRunId: "run-1",
    stage: "research",
    key: `research:${b.id}:extract:1`,
    payload: { security_id: "sec-1", report_id: b.id, step: "extract:1" },
    notBefore: "2030-01-01T00:00:00.000Z",
  });
  await w.store.enqueueJob({
    scanRunId: "run-1",
    stage: "research",
    key: `research:${other.id}:extract:1`,
    payload: { security_id: "sec-2", report_id: other.id, step: "extract:1" },
    notBefore: "2030-01-01T00:00:00.000Z",
  });
  await w.run(planJob({}, "sec-1", "manual"));
  const get = (id: string) => w.store.reports.get(id);
  for (const old of [a, b, c])
    assertEquals([get(old.id)?.status, get(old.id)?.error], ["failed", "superseded"]);
  assertEquals(get(other.id)?.status, "running", "another security is untouched");
  assertEquals(w.store.jobs.filter((j) => j.payload.report_id === b.id).length, 0);
  const done = [...w.store.reports.values()].find((r) => r.trigger === "manual");
  assertEquals(done?.status, "complete");
});

Deno.test("visitor: the request cap of the day spent on every model is no_quota, not providers_busy", async () => {
  const w = chainWorld();
  w.settings.value = { ...w.settings.value, llm_daily_request_cap: 1 };
  for (const m of w.models) w.store.quota.set(`${m.name}|llm_requests|day`, 1);
  await w.run(planJob({}, "sec-1", "visitor"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "no_quota"]);
  assertEquals(
    w.models.map((m) => m.calls.length),
    [0, 0, 0],
  );
});

Deno.test("only monitored holdings park: any other trigger fails instead", async () => {
  const w = chainWorld();
  for (const m of w.models) m.responder = quota;
  await w.run(planJob({}, "sec-1", "new_discount"));
  const r = reportOf(w);
  assertEquals([r.status, r.error], ["failed", "no_quota"]);
});
