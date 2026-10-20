import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { STAGE1_SYSTEM } from "../../_shared/core/research.ts";
import { seedResearchStage } from "./research_seed.ts";
import { makeWorld, planJob, SEC_1, scriptedResponder, type World } from "./testing/fakes.ts";

const reportsOf = (w: World, id = "sec-1") =>
  [...w.store.reports.values()].filter((r) => r.securityId === id);

async function addCurrent(
  w: World,
  over: { visibility?: "public" | "holders"; completedAt?: string; key?: string } = {},
) {
  const current = await w.store.createReport({
    idempotencyKey: over.key ?? "old-key",
    securityId: "sec-1",
    companyId: "co-1",
    scanRunId: "old",
    trigger: "new_discount",
    visibility: over.visibility ?? "public",
  });
  await w.store.patchReport(current.id, {
    status: "complete",
    isCurrent: true,
    completedAt: over.completedAt ?? "2026-10-10T08:00:00.000Z",
    conclusion: "Meets these two fundamental checks.",
    bankruptcyRisk: "Low",
    materialDamageEstablished: false,
    sufficientEvidence: true,
    summary: "Earlier summary.",
  });
  return current;
}

Deno.test("happy path: 13 steps end in complete + green with provenance, ledger and card", async () => {
  const w = makeWorld();
  assertEquals(await w.run(planJob()), 13);
  const [report] = reportsOf(w);
  assert(report);
  assertEquals(report.status, "complete");
  assertEquals(report.conclusion, "Meets these two fundamental checks.");
  assertEquals(report.bankruptcyRisk, "Low");
  assertEquals(report.isCurrent, true);
  assertEquals([report.provider, report.model], ["gemini", "fake-model"]);
  assert(report.promptVersion && report.schemaVersion);
  assertEquals(report.idempotencyKey, "sec-1:new_discount:2026-10-15");
  assertEquals(report.queriesUsed, 6);
  assertEquals(report.docsFetched, 8);
  assertEquals(report.researchCutoffDate, "2026-10-15");
  assertStringIncludes(report.reportMd ?? "", "## Sources");
  // budgets: 6 queries, 8 documents (3 EDGAR via Jina), 8 Stage-1 calls, one Stage-2 call
  assertEquals(w.tavily.queries.length, 6);
  assertEquals(w.fetch.directCalls.length + w.fetch.jinaCalls.length, 8);
  assertEquals(w.fetch.jinaCalls.filter((u) => u.includes("sec.gov")).length, 3);
  assertEquals(w.llm.stage1Calls.length, 8);
  assertEquals(w.llm.stage2Calls.length, 1);
  const card = w.store.cards[0];
  assertEquals(
    [card?.operationalCategory, card?.researchReportId, card?.withheld],
    ["green", report.id, false],
  );
  assertEquals(w.store.texts.size, 0, "transient texts are deleted at the end");
  // every URL in the stored report comes from a verified ledger row
  const sources = await w.store.listSources(report.id);
  const ledgerUrls = new Set(sources.map((s) => s.canonicalUrl));
  for (const url of (report.reportMd ?? "").match(/https?:\/\/[^\s)]+/g) ?? [])
    assert(ledgerUrls.has(url), url);
  for (const id of report.citedEvidenceIds) {
    const src = sources.find((s) => s.evidenceId === id);
    assertEquals(src?.verification, "ok");
    assertEquals(src?.usedInReport, true);
    assert(src?.retrievedAt && src.contentHash && src.httpStatus === 200);
  }
});

Deno.test("quota is consumed before every external call", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, max_full_reports_per_day: 4 };
  await w.run(planJob());
  assertEquals(w.tavily.quotaSeen, [1, 2, 3, 4, 5, 6]);
  assertEquals(w.llm.quotaSeen, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEquals(w.store.quota.get("research|full_reports:discount|day"), 1);
  assertEquals(w.store.quota.get("tavily|credits_report|day"), 6);
  assertEquals(w.store.quota.get("tavily|credits|month"), 6);
  assert(w.store.quotaCalls.every((c) => c.granted));
});

Deno.test("red path: High risk is classified red and withheld", async () => {
  const w = makeWorld();
  w.verdict.value = "red";
  await w.run(planJob());
  const card = w.store.cards[0];
  assertEquals(
    [card?.operationalCategory, card?.categoryReason, card?.withheld],
    ["red", "bankruptcy_high", true],
  );
  assertEquals(reportsOf(w)[0]?.bankruptcyRisk, "High");
});

Deno.test("amber path: Moderate risk with sufficient evidence is amber, never green", async () => {
  const w = makeWorld();
  w.verdict.value = "amber";
  await w.run(planJob());
  assertEquals(w.store.cards[0]?.operationalCategory, "amber");
});

Deno.test("unknown evidence id -> one retry with feedback -> failed, grey research_failed", async () => {
  const w = makeWorld();
  w.verdict.value = "unknown_id";
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals(
    [report?.status, report?.error, report?.isCurrent],
    ["failed", "unknown_evidence_id", false],
  );
  assertEquals(w.llm.stage2Calls.length, 2, "exactly one retry");
  assertStringIncludes(w.llm.stage2Calls[1]?.user ?? "", "CORRECTION REQUIRED");
  assertStringIncludes(w.llm.stage2Calls[1]?.user ?? "", "E999");
  assertEquals(
    [w.store.cards[0]?.operationalCategory, w.store.cards[0]?.categoryReason],
    ["grey", "research_failed"],
  );
  assertEquals(w.store.texts.size, 0);
});

Deno.test("inconsistent Meets is stored with a limitation and never maps to green", async () => {
  const w = makeWorld();
  w.verdict.value = "inconsistent";
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals(report?.status, "complete");
  assert(report?.limitations.includes("inconsistent_output"));
  assertNotEquals(w.store.cards[0]?.operationalCategory, "green");
  assertEquals(w.store.cards[0]?.operationalCategory, "grey");
});

Deno.test("Tavily exhausted at search:1 with >= 2 primary documents continues with limited_sources", async () => {
  const w = makeWorld();
  w.tavily.mode = "quota";
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals(report?.status, "complete");
  assert(report?.limitations.includes("limited_sources"));
  assertEquals(w.tavily.queries.length, 1, "no further search after the quota answer");
  assertStringIncludes(w.llm.stage2Calls[0]?.user ?? "", "evidence may be incomplete");
});

Deno.test("Tavily exhausted with no primary documents (monitored holding) -> quota_deferred, resumed (not duplicated) the next UTC day", async () => {
  const w = makeWorld({ security: { ...SEC_1, secCik: null } });
  w.edgar.filings = [];
  w.tavily.mode = "quota";
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const deferred = reportsOf(w)[0];
  assertEquals(
    [deferred?.status, deferred?.error, deferred?.step],
    ["quota_deferred", "tavily_quota", "search:1"],
  );
  assertEquals(deferred?.notBefore, "2026-10-16T00:05:00.000Z");
  assertEquals(
    [w.store.cards[0]?.operationalCategory, w.store.cards[0]?.categoryReason],
    ["pending", "research_quota_deferred"],
  );
  assertEquals(
    w.store.jobs.filter((j) => j.status === "queued").length,
    0,
    "nothing is retried the same day",
  );

  w.clock.now = new Date("2026-10-16T08:00:00Z");
  w.tavily.mode = "ok";
  w.store.scanRuns.push({ id: "run-2", scanDateLocal: "2026-10-16" });
  w.store.cards.push({
    id: 2,
    scanRunId: "run-2",
    mode: "worldwide",
    securityId: "sec-1",
    rank: 53,
    symbol: "ACME",
    researchReportId: null,
    operationalCategory: "pending",
  });
  assertEquals(await seedResearchStage(w.deps, "run-2", "2026-10-16"), 1);
  const resumed = w.store.jobs.find((j) => j.scanRunId === "run-2");
  assertEquals([resumed?.payload.step, resumed?.payload.report_id], ["search:1", deferred?.id]);
  await w.drain();
  assertEquals(reportsOf(w).length, 1);
  assertEquals(reportsOf(w)[0]?.status, "complete");
  assertEquals(w.store.cards.find((c) => c.id === 2)?.operationalCategory, "green");
});

Deno.test("LLM quota exhausted -> quota_deferred at the step reached, candidate stays pending", async () => {
  const w = makeWorld();
  w.llm.responder = () => ({ ok: false, kind: "quota", status: 429, message: "daily quota" });
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const report = reportsOf(w)[0];
  assertEquals(
    [report?.status, report?.error, report?.step],
    ["quota_deferred", "llm_quota", "extract:1"],
  );
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");
});

Deno.test("not configured -> quota_deferred with provider_not_configured and no external call", async () => {
  const w = makeWorld({ configured: false });
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const report = reportsOf(w)[0];
  assertEquals(
    [report?.status, report?.error, report?.step],
    ["quota_deferred", "provider_not_configured", "plan"],
  );
  assertEquals(w.llm.calls.length + w.tavily.queries.length + w.fetch.directCalls.length, 0);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");
});

Deno.test("max_full_reports_per_day reached -> the next discount is deferred with daily_cap", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, max_full_reports_per_day: 1 };
  w.store.securities.set("sec-2", {
    ...SEC_1,
    securityId: "sec-2",
    companyId: "co-2",
    companyName: "Beta Inc",
    ticker: "BETA",
  });
  w.store.cards.push({
    id: 2,
    scanRunId: "run-1",
    mode: "worldwide",
    securityId: "sec-2",
    rank: 60,
    symbol: "BETA",
    researchReportId: null,
    operationalCategory: "pending",
  });
  await w.run(planJob({}, "sec-1", "monitor_first"));
  await w.run(planJob({}, "sec-2", "monitor_first"));
  assertEquals(reportsOf(w, "sec-1")[0]?.status, "complete");
  const second = reportsOf(w, "sec-2")[0];
  assertEquals([second?.status, second?.error], ["quota_deferred", "daily_cap"]);
  assertEquals(w.store.cards.find((c) => c.securityId === "sec-2")?.operationalCategory, "pending");
});

const addSecond = (w: World) => {
  w.store.securities.set("sec-2", {
    ...SEC_1,
    securityId: "sec-2",
    companyId: "co-2",
    companyName: "Beta Inc",
    ticker: "BETA",
  });
  w.store.cards.push({
    id: 2,
    scanRunId: "run-1",
    mode: "worldwide",
    securityId: "sec-2",
    rank: 60,
    symbol: "BETA",
    researchReportId: null,
    operationalCategory: "pending",
  });
};

Deno.test("max_full_reports_per_day null -> every discount is researched and no report counter is touched", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, max_full_reports_per_day: null };
  addSecond(w);
  await w.run(planJob());
  await w.run(planJob({}, "sec-2"));
  assertEquals(reportsOf(w, "sec-1")[0]?.status, "complete");
  assertEquals(reportsOf(w, "sec-2")[0]?.status, "complete");
  assertEquals(
    w.store.quotaCalls.filter((c) => c.resource.startsWith("full_reports")).length,
    0,
    "no reservation against an unlimited cap",
  );
});

Deno.test("max_full_reports_per_day absent -> treated as unlimited", async () => {
  const w = makeWorld();
  const { max_full_reports_per_day: _drop, ...rest } = w.settings.value;
  w.settings.value = rest as typeof w.settings.value;
  await w.run(planJob());
  assertEquals(reportsOf(w)[0]?.status, "complete");
  assertEquals(w.store.quotaCalls.filter((c) => c.resource.startsWith("full_reports")).length, 0);
});

Deno.test("unlimited reports: the Tavily cap still defers", async () => {
  const w = makeWorld({ security: { ...SEC_1, secCik: null } });
  w.edgar.filings = [];
  w.settings.value = { ...w.settings.value, max_full_reports_per_day: null, tavily_daily_cap: 0 };
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error], ["quota_deferred", "tavily_quota"]);
});

Deno.test("unlimited reports: the LLM request cap still defers", async () => {
  const w = makeWorld();
  w.settings.value = {
    ...w.settings.value,
    max_full_reports_per_day: null,
    llm_daily_request_cap: 0,
  };
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error], ["quota_deferred", "llm_quota"]);
});

Deno.test("re-running plan creates one report and reserves quota once", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, max_full_reports_per_day: 4 };
  const job = planJob();
  await w.run(job, {}, 1); // plan only
  const planned = reportsOf(w)[0];
  assert(planned);
  await w.handle({ ...job, key: `${job.key}:redelivered` }); // the same plan delivered again after a killed invocation
  assertEquals(reportsOf(w).length, 1);
  assertEquals(w.store.quota.get("research|full_reports:discount|day"), 1);
  assertEquals(w.store.jobs.filter((j) => j.key === `research:${planned.id}:prefetch`).length, 1);
});

Deno.test("fetch re-run does not refetch ok documents", async () => {
  const w = makeWorld();
  await w.run(planJob(), {}, 5); // plan, prefetch, search:1, search:2, fetch:1
  const report = reportsOf(w)[0];
  assert(report);
  const before = w.fetch.directCalls.length + w.fetch.jinaCalls.length;
  assertEquals(before, 3);
  await w.handle({
    id: 99,
    scan_run_id: "run-1",
    stage: "research",
    key: `research:${report.id}:fetch:1:again`,
    payload: {
      security_id: "sec-1",
      trigger: "new_discount",
      scan_date_local: "2026-10-15",
      report_id: report.id,
      step: "fetch:1",
    },
  });
  assertEquals(w.fetch.directCalls.length + w.fetch.jinaCalls.length, before);
});

Deno.test("reuse links a current report <= 30 days old and creates no row and no external call", async () => {
  const w = makeWorld();
  const current = await addCurrent(w);
  await w.run(planJob());
  assertEquals(reportsOf(w).length, 1);
  assertEquals(
    [w.store.cards[0]?.researchReportId, w.store.cards[0]?.operationalCategory],
    [current.id, "green"],
  );
  assertEquals(
    w.llm.calls.length +
      w.tavily.queries.length +
      w.fetch.directCalls.length +
      w.edgar.calls.length,
    0,
  );
});

Deno.test("reuse is skipped for an old report, a holders-only report and a newer finding; the new report supersedes", async () => {
  for (const variant of ["old", "holders", "finding"] as const) {
    const w = makeWorld();
    const current = await addCurrent(w, {
      visibility: variant === "holders" ? "holders" : "public",
      completedAt: variant === "old" ? "2026-09-01T00:00:00.000Z" : "2026-10-10T08:00:00.000Z",
    });
    if (variant === "finding")
      w.store.findings.push({ securityId: "sec-1", detectedAt: "2026-10-12T00:00:00.000Z" });
    await w.run(planJob());
    assertEquals(reportsOf(w).length, 2, variant);
    const latest = reportsOf(w).find((r) => r.id !== current.id);
    assertEquals([latest?.status, latest?.supersedesId], ["complete", current.id], variant);
    assertEquals(w.store.reports.get(current.id)?.isCurrent, false, variant);
  }
});

Deno.test("a refresh of a stale report never downgrades the card while it runs", async () => {
  const w = makeWorld();
  const current = await addCurrent(w, { completedAt: "2026-09-01T00:00:00.000Z" });
  await w.store.applyReportToCards({
    scanRunId: "run-1",
    securityId: "sec-1",
    reportId: current.id,
    category: "green",
    reasonCode: "meets_checks",
    summary: "Earlier summary.",
    conclusion: null,
    bankruptcyRisk: null,
    completedAt: "2026-09-01T00:00:00.000Z",
  });
  await w.run(planJob({}, "sec-1", "refresh"), {}, 4); // plan .. search:2, report still running
  assertEquals(reportsOf(w).find((r) => r.id !== current.id)?.status, "running");
  assertEquals(w.store.cards[0]?.operationalCategory, "green");
  assertEquals(w.store.cards[0]?.researchReportId, current.id);
});

Deno.test("validate: unverified cited sources are liveness-checked (<= 4 GETs); failures end in citation_verification_failed", async () => {
  const w = makeWorld();
  w.verdict.value = "cite_unverified";
  for (let n = 1; n <= 6; n++) w.fetch.failUrls.add(`https://news.example.com/story-${n}`);
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error], ["failed", "citation_verification_failed"]);
  assertEquals(w.store.cards[0]?.operationalCategory, "grey");
  assert((report?.usage.liveness_checks ?? 99) <= 4, "at most 4 GETs per report");
  assertEquals(
    w.fetch.directTimeouts.filter((t) => t === 8000).length,
    4,
    "the budget is cumulative: the Stage-2 retry gets no fresh 4 GETs",
  );
  assertEquals(w.llm.stage2Calls.length, 2, "one retry with the unverified ids excluded");
});

Deno.test("Stage 1 facts whose quote is not in the document are dropped", async () => {
  const w = makeWorld();
  const inner = scriptedResponder(() => w.verdict.value);
  w.llm.responder = (req) => {
    const res = inner(req);
    if (req.system === STAGE1_SYSTEM && res.ok) {
      const fact = (res.json as { facts: { quote: string }[] }).facts[0];
      if (fact) fact.quote = "a fabricated quotation that is not in the text";
    }
    return res;
  };
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assert(report);
  assert((report.usage.dropped_facts ?? 0) >= 8);
  const sources = await w.store.listSources(report.id);
  assert(sources.filter((s) => s.verification === "ok").every((s) => s.extracted.length === 0));
});

Deno.test("prompts, queries and fetches contain no user ids or quantities and are identical for a held security", async () => {
  const run = async (trigger: string) => {
    const w = makeWorld();
    w.store.secrets = { user: "user-0000-secret", qty: "777 shares", basis: "cost basis 12.34" };
    await w.run(planJob({}, "sec-1", trigger));
    return w;
  };
  const candidate = await run("new_discount");
  const held = await run("monitor_first");
  for (const w of [candidate, held]) {
    const traffic = JSON.stringify([
      w.llm.calls,
      w.tavily.queries,
      w.fetch.directCalls,
      w.fetch.jinaCalls,
    ]);
    for (const secret of Object.values(w.store.secrets))
      assertEquals(traffic.includes(secret), false, secret);
    assert(w.llm.stage2Calls.length === 1);
  }
  assertEquals(candidate.llm.stage2Calls[0]?.user, held.llm.stage2Calls[0]?.user);
  assertEquals(candidate.llm.stage2Calls[0]?.system, held.llm.stage2Calls[0]?.system);
  assertEquals(candidate.tavily.queries, held.tavily.queries);
});

Deno.test("a step short of time re-enqueues itself with a numeric suffix instead of overrunning", async () => {
  const w = makeWorld();
  await w.run(planJob(), { deadline: performance.now() + 500 }, 5); // plan, prefetch, search:1, search:2, fetch:1
  const again = w.store.jobs.find((j) => /:fetch:1:1$/.test(j.key));
  assert(again, "fetch:1 re-enqueued as :1");
  assertEquals(reportsOf(w)[0]?.status, "running");
});

Deno.test("an LLM transport failure (http) throws so the worker retries with backoff", async () => {
  const w = makeWorld();
  w.llm.responder = () => ({ ok: false, kind: "http", status: 503, message: "unavailable" });
  let thrown = "";
  try {
    await w.run(planJob());
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertStringIncludes(thrown, "llm http");
});

Deno.test("a manual report never downgrades a published card while it runs", async () => {
  const w = makeWorld();
  const current = await addCurrent(w, { completedAt: "2026-09-01T00:00:00.000Z" });
  await w.store.applyReportToCards({
    scanRunId: "run-1",
    securityId: "sec-1",
    reportId: current.id,
    category: "green",
    reasonCode: "meets_checks",
    summary: "Earlier summary.",
    conclusion: null,
    bankruptcyRisk: null,
    completedAt: "2026-09-01T00:00:00.000Z",
  });
  await w.run(planJob({}, "sec-1", "manual"), {}, 4);
  assertEquals(reportsOf(w).find((r) => r.id !== current.id)?.status, "running");
  assertEquals(
    [w.store.cards[0]?.operationalCategory, w.store.cards[0]?.researchReportId],
    ["green", current.id],
  );
  // a manual report that runs out of quota is failed (never parked) and keeps the card too
  w.llm.responder = () => ({ ok: false, kind: "quota", status: 429, message: "daily quota" });
  await w.drain();
  const ended = reportsOf(w).find((r) => r.id !== current.id);
  assertEquals([ended?.status, ended?.error], ["failed", "no_quota"]);
  assertEquals(w.store.cards[0]?.operationalCategory, "green");
});

Deno.test("the last attempt of a dead research job fails the report (grey research_failed); earlier attempts rethrow", async () => {
  const w = makeWorld();
  await w.run(planJob(), {}, 7); // plan .. fetch:3
  w.llm.responder = () => ({ ok: false, kind: "http", status: 503, message: "unavailable" });
  const queued = w.store.jobs.find((j) => j.status === "queued" && j.key.endsWith(":extract:1"));
  assert(queued);
  const job = {
    id: 99,
    scan_run_id: "run-1",
    stage: "research",
    key: queued.key,
    payload: queued.payload,
  };
  let thrown = "";
  try {
    await w.handle({ ...job, attempts: 2, max_attempts: 5 });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertStringIncludes(thrown, "llm http");
  assertEquals(reportsOf(w)[0]?.status, "running");
  await w.handle({ ...job, attempts: 5, max_attempts: 5 });
  assertEquals([reportsOf(w)[0]?.status, reportsOf(w)[0]?.error], ["failed", "job_failed"]);
  assertEquals(
    [w.store.cards[0]?.operationalCategory, w.store.cards[0]?.categoryReason],
    ["grey", "research_failed"],
  );
  assertEquals(w.store.texts.size, 0);
});

Deno.test("a missing Tavily key defers with provider_not_configured and reserves no credit", async () => {
  const w = makeWorld();
  w.tavily.configured = false;
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const report = reportsOf(w)[0];
  assertEquals(
    [report?.status, report?.error, report?.step],
    ["quota_deferred", "provider_not_configured", "search:1"],
  );
  assertEquals(w.tavily.queries.length, 0);
  assertEquals(w.store.quota.get("tavily|credits|day") ?? 0, 0);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");
});

Deno.test("a holders-only report is never linked to a public card", async () => {
  const w = makeWorld();
  await w.run(planJob({}, "sec-1", "monitor_first"));
  const report = reportsOf(w)[0];
  assertEquals(report?.visibility, "public", "a security with a discount card is public");
  w.store.cards[0] = {
    ...(w.store.cards[0] as NonNullable<(typeof w.store.cards)[0]>),
    researchReportId: null,
    operationalCategory: "pending",
  };
  const holders = await w.store.createReport({
    idempotencyKey: "h-1",
    securityId: "sec-1",
    companyId: "co-1",
    scanRunId: "run-1",
    trigger: "monitor_first",
    visibility: "holders",
  });
  await w.store.patchReport(holders.id, {
    status: "complete",
    conclusion: "Meets these two fundamental checks.",
    bankruptcyRisk: "Low",
    materialDamageEstablished: false,
    sufficientEvidence: true,
    completedAt: "2026-10-15T07:00:00.000Z",
  });
  await w.handle(planJob({ report_id: holders.id }, "sec-1", "monitor_first"));
  assertEquals(
    [w.store.cards[0]?.researchReportId, w.store.cards[0]?.operationalCategory],
    [null, "pending"],
  );
});

Deno.test("an LLM per-minute 429 retries the step within minutes, not the next UTC day", async () => {
  const w = makeWorld();
  const answer = w.llm.responder;
  let limited = true;
  w.llm.responder = (req) =>
    limited ? { ok: false, kind: "rate_limited", status: 429, message: "per minute" } : answer(req);
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertNotEquals(report?.status, "quota_deferred");
  const queued = w.store.jobs.filter((j) => j.status === "queued");
  assertEquals(queued.length, 1);
  const wait = Date.parse(queued[0]?.notBefore ?? "") - w.clock.now.getTime();
  assert(wait >= 60_000 && wait <= 120_000, `retry delay ${wait} ms`);

  limited = false;
  w.clock.now = new Date(w.clock.now.getTime() + 121_000);
  await w.drain();
  assertEquals(reportsOf(w)[0]?.status, "complete");
});

Deno.test("a Tavily per-minute 429 retries the search step soon; repeated 429s end in the day-long deferral", async () => {
  const w = makeWorld({ security: { ...SEC_1, secCik: null } });
  w.edgar.filings = [];
  w.tavily.mode = "rate_limited";
  await w.run(planJob({}, "sec-1", "monitor_first"));
  assertNotEquals(reportsOf(w)[0]?.status, "quota_deferred");
  for (let i = 0; i < 6; i++) {
    w.clock.now = new Date(w.clock.now.getTime() + 121_000);
    await w.drain();
  }
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error], ["quota_deferred", "tavily_quota"]);
});
