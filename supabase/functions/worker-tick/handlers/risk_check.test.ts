import { assert, assertEquals } from "@std/assert";
import type { EdgarClient, Filing } from "../../_shared/adapters/fetchers/edgar.ts";
import type { Job } from "../../_shared/adapters/research_types.ts";
import { CHANGE_SYSTEM } from "../../_shared/core/risk.ts";
import { researchHandler } from "./research.ts";
import { riskCheckHandler, seedChecks } from "./risk_check.ts";
import { FakeMonitor } from "./testing/fake_monitor.ts";
import { makeWorld, SEC_1, scriptedResponder, type World } from "./testing/fakes.ts";

const EIGHT_K = {
  id: "0000000001-26-000099",
  title: "8-K filed 2026-10-14",
  form: "8-K",
  publishedAt: "2026-10-14",
  link: "https://www.sec.gov/Archives/edgar/data/1/000000000126000099/k8.htm",
};
const checkJob = (): Job => ({
  id: 1,
  scan_run_id: "run-1",
  stage: "research",
  key: "research:sec-1:check",
  payload: { kind: "change_check", security_id: "sec-1", scan_date_local: "2026-10-15" },
});
const ctx = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const MATERIAL = {
  material: true,
  category: "liquidity_debt",
  severity: "material",
  summary: "Going-concern doubt disclosed.",
  evidence_ids: [1],
};

function setup() {
  const w = makeWorld();
  w.edgar.filings = [filingOf(EIGHT_K)];
  w.deps.sha256 = async (text) => `h:${text}`;
  const monitor = new FakeMonitor();
  const answer = { value: MATERIAL as unknown };
  const inner = scriptedResponder(() => w.verdict.value);
  w.llm.responder = (req) =>
    req.system === CHANGE_SYSTEM
      ? { ok: true, usage: { input: 10, output: 5 }, model: "fake-model", json: answer.value }
      : inner(req);
  const handler = riskCheckHandler(w.deps, monitor);
  return { w, monitor, answer, handler };
}
const filingOf = (k: typeof EIGHT_K): Filing => ({
  form: k.form,
  accession: k.id,
  filingDate: k.publishedAt,
  primaryDocument: "k8.htm",
  reportDate: null,
});
const seenAll = { edgar: ["old-1"], rss: ["old-r"], yahoo: ["old-y"] };
const withReport = { lastReportId: "rep-0" };
const jobsOf = (w: World, stage = "research") =>
  w.store.jobs.filter((j) => j.stage === stage).map((j) => j.key);

Deno.test("first observation records a baseline without any search or model call", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
  });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "baseline");
  assertEquals(monitor.monitorRows[0]?.seen.edgar, [EIGHT_K.id]);
  assertEquals(w.tavily.queries.length + w.llm.calls.length, 0);
});

Deno.test("no delta: only last_check_at moves; no search, no model call, no quota", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: { edgar: [EIGHT_K.id], yahoo: [] },
  });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "no_delta");
  assertEquals(w.tavily.queries.length + w.llm.calls.length, 0);
  assertEquals(w.store.quota.size, 0);
  assertEquals(monitor.touched.length, 1);
  assertEquals(monitor.touched[0]?.seen, undefined, "seen is not rewritten");
  assertEquals(monitor.monitorRows[0]?.nextDueAt, "2026-10-18T08:00:00.000Z"); // 72 h (min_recheck_hours), was 20 h
});

Deno.test("no report yet: monitor_first is enqueued regardless of delta", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    seen: { edgar: [EIGHT_K.id] },
  });
  await handler(checkJob(), ctx());
  assertEquals(jobsOf(w), ["research:sec-1:monitor_first:plan"]);
  const job = w.store.jobs[0];
  assertEquals([job?.priority, job?.payload.trigger], [30, "monitor_first"]);
});

Deno.test("delta, not material: one Tavily query and one small call, no finding, seen updated", async () => {
  const { w, monitor, answer, handler } = setup();
  answer.value = {
    material: false,
    category: "other",
    severity: "watch",
    summary: "Routine filing.",
    evidence_ids: [1],
  };
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "not_material");
  assertEquals([w.tavily.queries.length, w.llm.calls.length], [1, 1]);
  assertEquals(w.tavily.queries[0], "Acme Corp ACME announcement");
  assertEquals(monitor.findings.length, 0);
  assertEquals(jobsOf(w), []);
  assert(monitor.monitorRows[0]?.seen.edgar?.includes(EIGHT_K.id));
  assertEquals(w.store.quota.get("research|change_checks|day"), 1);
});

Deno.test("material: findings for every monitoring user, fingerprint over category and primary URLs, one monitor_change report", async () => {
  const { w, monitor, handler } = setup();
  monitor.previous = { category: "green", summary: "Stable.", date: "2026-09-20" };
  for (const userId of ["u1", "u2"])
    monitor.addRow({
      userId,
      securityId: "sec-1",
      ...withReport,
      seen: seenAll,
    });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "material");
  const expected = `h:liquidity_debt\n${EIGHT_K.link}`;
  assertEquals(
    monitor.findings.map((f) => [f.userId, f.fingerprint, f.category, f.severity]),
    [
      ["u1", expected, "liquidity_debt", "material"],
      ["u2", expected, "liquidity_debt", "material"],
    ],
  );
  assertEquals(monitor.findings[0]?.evidence, [
    { id: 1, url: EIGHT_K.link, title: EIGHT_K.title, primary: true },
  ]);
  assertEquals(jobsOf(w), ["research:sec-1:monitor_change:plan"]);
  const job = w.store.jobs[0];
  assertEquals([job?.priority, job?.payload.trigger], [40, "monitor_change"]);
  assert(w.llm.calls[0]?.user.includes("PREVIOUS ASSESSMENT: category=green"));
  assert(!JSON.stringify(w.llm.calls).includes("u1"), "no user id reaches the model");
});

Deno.test("duplicate suppression: same primary evidence updates the open finding; new primary evidence inserts and re-queues", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  await handler(checkJob(), ctx());
  assertEquals(monitor.findings.length, 1);
  // the same item is reported again (for example the seen list was reset): the open finding is only updated
  monitor.monitorRows[0]!.seen = seenAll;
  await handler({ ...checkJob(), key: "research:sec-1:check:2" }, ctx());
  assertEquals(monitor.findings.length, 1);
  assertEquals(jobsOf(w), ["research:sec-1:monitor_change:plan"], "no second report job");
  // a different 8-K is new primary-source evidence
  const other = {
    ...EIGHT_K,
    id: "0000000001-26-000100",
    link: "https://www.sec.gov/Archives/edgar/data/1/000000000126000100/k8.htm",
  };
  monitor.monitorRows[0]!.seen = seenAll;
  w.edgar.filings = [filingOf(other)];
  await handler({ ...checkJob(), key: "research:sec-1:check:3" }, ctx());
  assertEquals(monitor.findings.length, 2);
});

Deno.test("quota: daily check cap, LLM cap and missing provider defer without marking anything seen; Tavily denial still classifies", async () => {
  const cap = setup();
  cap.monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  cap.w.settings.value = { ...cap.w.settings.value, max_change_checks_per_day: 0 };
  assertEquals(
    ((await cap.handler(checkJob(), ctx())) as { outcome: string }).outcome,
    "deferred_cap",
  );
  assertEquals(cap.w.llm.calls.length + cap.w.tavily.queries.length, 0);
  assertEquals(cap.monitor.monitorRows[0]?.seen, seenAll);

  const llm = setup();
  llm.monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  llm.w.settings.value = { ...llm.w.settings.value, llm_daily_request_cap: 0 };
  assertEquals(
    ((await llm.handler(checkJob(), ctx())) as { outcome: string }).outcome,
    "deferred_llm",
  );
  assertEquals(llm.monitor.findings.length, 0);

  const none = makeWorld({ configured: false });
  const monitor = new FakeMonitor();
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  assertEquals(
    ((await riskCheckHandler(none.deps, monitor)(checkJob(), ctx())) as { outcome: string })
      .outcome,
    "deferred_provider",
  );

  const noSearch = setup();
  noSearch.monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  noSearch.w.settings.value = { ...noSearch.w.settings.value, tavily_daily_cap: 0 };
  const res = (await noSearch.handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "material");
  assertEquals([noSearch.w.tavily.queries.length, noSearch.w.llm.calls.length], [0, 1]);
});

Deno.test("an invalid answer is retried once, then the check is left unacknowledged; http failures throw", async () => {
  const { w, monitor, answer, handler } = setup();
  answer.value = { nonsense: true };
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: seenAll,
  });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "llm_invalid");
  assertEquals(w.llm.calls.length, 2);
  assertEquals(monitor.monitorRows[0]?.seen, seenAll);
  w.llm.responder = () => ({ ok: false, kind: "http", status: 503, message: "down" });
  let thrown = "";
  try {
    await handler(checkJob(), ctx());
  } catch (e) {
    thrown = (e as Error).message;
  }
  assert(thrown.includes("llm http"));
});

Deno.test("Yahoo titles need a keyword; unmatched titles never trigger a check", async () => {
  const { w, monitor, handler } = setup();
  w.edgar.filings = [];
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll });
  const news = (uuid: string, title: string) => ({
    uuid,
    title,
    link: `https://finance.yahoo.com/n/${uuid}`,
    providerPublishTime: new Date("2026-10-14T00:00:00Z"),
  });
  w.yahoo.items = [news("y9", "Acme opens a new store")];
  assertEquals(((await handler(checkJob(), ctx())) as { outcome: string }).outcome, "no_delta");
  w.yahoo.items = [news("y10", "Acme faces fraud claims")];
  assertEquals(((await handler(checkJob(), ctx())) as { outcome: string }).outcome, "material");
  assertEquals(
    w.tavily.queries[0],
    "Acme Corp ACME fraud",
    "the strongest keyword drives the query",
  );
  assertEquals(
    monitor.findings[0]?.evidence[0]?.primary,
    false,
    "Yahoo news is never primary evidence",
  );
});

Deno.test("the seeder queues one check per due security and the research dispatcher routes it", async () => {
  const { w, monitor, answer } = setup();
  answer.value = {
    material: false,
    category: "other",
    severity: "watch",
    summary: "Routine.",
    evidence_ids: [],
  };
  monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: { edgar: [EIGHT_K.id] },
    nextDueAt: "2026-10-14T00:00:00.000Z",
  });
  monitor.addRow({
    userId: "u1",
    securityId: "sec-2",
    ...withReport,
    nextDueAt: "2026-10-17T00:00:00.000Z",
  });
  const seed = seedChecks(w.deps, monitor);
  assertEquals(await seed("run-1", "2026-10-15"), 1);
  await seed("run-1", "2026-10-15");
  const job = w.store.jobs[0];
  assertEquals(
    [job?.key, job?.priority, job?.payload.kind],
    ["research:sec-1:check", 50, "change_check"],
  );
  w.deps.changeCheck = riskCheckHandler(w.deps, monitor);
  const res = (await researchHandler(w.deps)(
    {
      id: 1,
      scan_run_id: "run-1",
      stage: "research",
      key: job?.key ?? "",
      payload: job?.payload ?? {},
    },
    ctx(),
  )) as { outcome: string };
  assertEquals(res.outcome, "no_delta");
});

Deno.test("EDGAR failure is recorded as unavailable, never as no change, and the other sources still run", async () => {
  const { w, monitor, handler } = setup();
  const down: EdgarClient = {
    resolveCik: (t) => w.edgar.resolveCik(t),
    filingUrl: (c, a, d) => w.edgar.filingUrl(c, a, d),
    submissions: async () => ({ ok: false, kind: "http", message: "503" }),
  };
  w.deps.edgar = down;
  const row = monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll });
  const res = (await handler(checkJob(), ctx())) as { outcome: string; unavailable?: string[] };
  assertEquals([res.outcome, res.unavailable], ["sources_unavailable", ["edgar"]]);
  assertEquals(w.tavily.queries.length + w.llm.calls.length, 0);
  assertEquals(row.seen, seenAll, "nothing is acknowledged");
  // Yahoo still works and finds a keyword item while EDGAR is down
  w.yahoo.items = [
    {
      uuid: "y1",
      title: "Acme fraud probe",
      link: "https://finance.yahoo.com/n/y1",
      providerPublishTime: new Date(),
    },
  ];
  const second = (await handler(checkJob(), ctx())) as { outcome: string; unavailable?: string[] };
  assertEquals([second.outcome, second.unavailable], ["material", ["edgar"]]);
  assertEquals(row.seen.edgar, ["old-1"], "the unread channel keeps its previous ids");
});

Deno.test("a new 8-K and a new RSS item become the delta; a channel seen for the first time only records a baseline", async () => {
  const { w, monitor, handler } = setup();
  w.edgar.filings = [filingOf(EIGHT_K), { ...filingOf(EIGHT_K), form: "4", accession: "form4" }];
  w.store.securities.set("sec-1", { ...SEC_1, irRssUrls: ["https://ir.acme.example/feed"] });
  w.fetch.feedItems = [
    { guid: "r-new", title: "Q3 outlook", link: "https://ir.acme.example/r-new", published: null },
  ];
  const row = monitor.addRow({
    userId: "u1",
    securityId: "sec-1",
    ...withReport,
    seen: { edgar: ["old-1"] },
  });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "material");
  assertEquals(w.llm.calls.length, 1);
  assert(w.llm.calls[0]?.user.includes("kind=edgar_filing"));
  assert(
    !w.llm.calls[0]?.user.includes("r-new"),
    "the first RSS observation is a baseline, not a delta",
  );
  assertEquals(row.seen.rss, ["r-new"]);
  assertEquals(row.seen.edgar, ["old-1", EIGHT_K.id], "only watch forms are tracked");
});
