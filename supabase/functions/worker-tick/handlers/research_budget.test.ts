import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { GenerateJsonRequest, GenerateJsonResult } from "../../_shared/adapters/llm/types.ts";
import {
  BUDGET_TOTAL_TOKENS,
  CHARS_PER_TOKEN,
  estimateTokens,
} from "../../_shared/core/llm-budget.ts";
import { STAGE1_SYSTEM } from "../../_shared/core/research.ts";
import { CHANGE_CLASSIFICATION_SCHEMA, CHANGE_SYSTEM } from "../../_shared/core/risk.ts";
import { riskCheckHandler } from "./risk_check.ts";
import { FakeMonitor } from "./testing/fake_monitor.ts";
import { makeWorld, planJob, scriptedResponder, type World } from "./testing/fakes.ts";

const GROQ_BUDGET = { maxInputTokens: 4500, maxOutputTokens: 3000 };

const reportOf = (w: World) => {
  const all = [...w.store.reports.values()];
  assertEquals(all.length, 1);
  return all[0] as NonNullable<(typeof all)[number]>;
};

/** Everything sent to the model counts: system prompt, the schema (Groq injects it into the prompt) and the user message. */
const requestChars = (req: GenerateJsonRequest) =>
  req.system.length + JSON.stringify(req.schema).length + req.user.length;
const estimate = (req: GenerateJsonRequest) =>
  estimateTokens(requestChars(req)) + req.maxOutputTokens;

/** A world whose primary is unconfigured, so the budgeted alternate writes the report. */
function altWorld(budget = GROQ_BUDGET) {
  const w = makeWorld({ configured: false, alternate: true });
  const alt = w.alt;
  assert(alt);
  alt.budget = budget;
  w.fetch.bodyWords = 8000; // a long filing: well over the 48,000 character document cap
  return { w, alt };
}

const tooLarge = (): GenerateJsonResult<unknown> => ({
  ok: false,
  kind: "schema",
  status: 413,
  message: "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM)",
  tooLarge: true,
});

Deno.test("primary: the full budget (4096 / 6144 output, whole documents, 48k evidence cap)", async () => {
  const w = makeWorld();
  w.fetch.bodyWords = 8000;
  await w.run(planJob());
  assertEquals(reportOf(w).status, "complete");
  assert(w.llm.stage1Calls.length > 0);
  for (const c of w.llm.stage1Calls) {
    assertEquals(c.maxOutputTokens, 4096);
    assert(c.user.length > 40_000, "the whole document is sent");
  }
  for (const c of w.llm.stage2Calls) assertEquals(c.maxOutputTokens, 6144);
  assertNotEquals(reportOf(w).evidenceTrimmed, true);
});

Deno.test("alternate with a budget: every step is sized under 7,500 tokens and the report is marked trimmed", async () => {
  const { w, alt } = altWorld();
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals(r.status, "complete");
  assertEquals(r.provider, "mistral");
  assertEquals(r.evidenceTrimmed, true);
  assert(alt.stage1Calls.length > 0 && alt.stage2Calls.length === 1);
  for (const c of [...alt.stage1Calls, ...alt.stage2Calls]) {
    assertEquals(c.maxOutputTokens, 3000, "lowered to the alternate's output cap");
    assert(
      requestChars(c) <= Math.floor(4500 * CHARS_PER_TOKEN),
      `request ${requestChars(c)} chars is over the input budget`,
    );
    assert(estimate(c) <= BUDGET_TOTAL_TOKENS, `estimate ${estimate(c)} tokens`);
  }
  assert(
    (r.usage.missing ?? []).some((m) => m.includes("read only in part")),
    "the report records which documents were read only in part",
  );
});

Deno.test("alternate with a budget: Stage 2 evidence left out is reported as omitted and shown_ids match what was sent", async () => {
  const { w, alt } = altWorld({ maxInputTokens: 1500, maxOutputTokens: 3000 });
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals(r.status, "complete");
  const call = alt.stage2Calls[0];
  assert(call);
  assert(call.user.includes("left out to fit the backup model's size limit"));
  const sent = [...call.user.matchAll(/^\[E(\d+)\]/gm)].map((m) => Number(m[1]));
  assertEquals(r.usage.shown_ids, sent);
  // the same evidence on the primary shows more entries
  const p = makeWorld();
  p.fetch.bodyWords = 8000;
  await p.run(planJob());
  const full = [...(p.llm.stage2Calls[0]?.user ?? "").matchAll(/^\[E(\d+)\]/gm)].length;
  assert(sent.length < full, `${sent.length} < ${full}`);
});

Deno.test("alternate without a budget (env unset) gets the same full request as the primary", async () => {
  const w = makeWorld({ configured: false, alternate: true });
  w.fetch.bodyWords = 8000;
  await w.run(planJob());
  const alt = w.alt;
  assert(alt);
  assertEquals(reportOf(w).status, "complete");
  assertNotEquals(reportOf(w).evidenceTrimmed, true);
  for (const c of alt.stage1Calls) assertEquals(c.maxOutputTokens, 4096);
  for (const c of alt.stage2Calls) assertEquals(c.maxOutputTokens, 6144);
});

Deno.test("request too large: one retry with half the input, then the report fails cleanly (no loop, no wait fields)", async () => {
  const { w, alt } = altWorld();
  const answer = alt.responder;
  alt.responder = (req) => (req.schemaName === "research_output" ? tooLarge() : answer(req));
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals(alt.stage2Calls.length, 2, "full budget, then half the input, then stop");
  const [first, second] = alt.stage2Calls;
  assert(first && second);
  assert(requestChars(second) < requestChars(first), "the retry is smaller");
  assertEquals(second.maxOutputTokens, first.maxOutputTokens);
  assertEquals([r.status, r.error], ["failed", "invalid_json"]);
  assertEquals([r.waitReason, r.nextAttemptAt], [null, null]);
  assertEquals(w.store.jobs.filter((j) => j.status === "queued").length, 0);
});

Deno.test("request too large once: the halved request succeeds and the report completes", async () => {
  const { w, alt } = altWorld();
  const answer = alt.responder;
  let refused = 0;
  alt.responder = (req) => {
    if (req.schemaName === "research_output" && refused++ === 0) return tooLarge();
    return answer(req);
  };
  await w.run(planJob());
  assertEquals(reportOf(w).status, "complete");
  assertEquals(alt.stage2Calls.length, 2);
  assert((reportOf(w).usage.shown_ids ?? []).length > 0);
});

Deno.test("a too-large Stage 1 request halves once, then that document counts as not extracted", async () => {
  const { w, alt } = altWorld();
  const answer = alt.responder;
  alt.responder = (req) => (req.system === STAGE1_SYSTEM ? tooLarge() : answer(req));
  await w.run(planJob());
  const r = reportOf(w);
  assert(alt.stage1Calls.length >= 2 && alt.stage1Calls.length % 2 === 0, "two tries per document");
  assert(r.limitations.some((l) => l.startsWith("extraction_failed:")));
  assertEquals(r.waitReason, null);
});

Deno.test("a TPM 429 stays rate_limited: the existing 90 second retry, not a size failure", async () => {
  const { w, alt } = altWorld();
  alt.responder = () => ({
    ok: false,
    kind: "rate_limited",
    status: 429,
    message: "Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7600, Requested 3000",
  });
  const t0 = w.clock.now.getTime();
  await w.run(planJob());
  const r = reportOf(w);
  assertEquals(r.status, "running");
  assertEquals(r.waitReason, "rate_limited");
  assertEquals(r.nextAttemptAt, new Date(t0 + 90_000).toISOString());
  assertEquals(alt.calls.length, 1, "no halved retry");
});

Deno.test("with a budget, 429 retries count consecutive 429s: a success resets them", async () => {
  const { w, alt } = altWorld();
  const answer = alt.responder;
  let n = 0;
  alt.responder = (req) =>
    n++ % 2 === 0 ? { ok: false, kind: "rate_limited", status: 429, message: "TPM" } : answer(req);
  await w.run(planJob());
  for (let i = 0; i < 60 && reportOf(w).status === "running"; i++) {
    w.clock.now = new Date(w.clock.now.getTime() + 100_000);
    await w.drain();
  }
  assertEquals(reportOf(w).status, "complete", "alternating 429s never exhaust the retries");
});

function changeCheck(w: World, monitor: FakeMonitor) {
  return riskCheckHandler(w.deps, monitor)(
    {
      id: 1,
      scan_run_id: "run-1",
      stage: "research",
      key: "research:sec-1:check",
      payload: { kind: "change_check", security_id: "sec-1", scan_date_local: "2026-10-15" },
    },
    { signal: new AbortController().signal, deadline: performance.now() + 60_000 },
  ) as Promise<{ outcome: string }>;
}
const seenOld = { edgar: ["old"], rss: ["old"], yahoo: ["old"] };
const news = (i: number, pad = 0) => ({
  uuid: `y${i}`,
  title: `Acme faces fraud claims number ${i} ${"x".repeat(pad)}`,
  link: `https://finance.yahoo.com/n/${i}`,
  providerPublishTime: new Date("2026-10-14T00:00:00Z"),
});

Deno.test("change classification: the primary keeps the full 16k message; the alternate is trimmed to its budget", async () => {
  const run = async (budgeted: boolean) => {
    const w = makeWorld({ configured: !budgeted, alternate: budgeted });
    const target = budgeted ? w.alt : w.llm;
    assert(target);
    if (budgeted) target.budget = { maxInputTokens: 3000, maxOutputTokens: 3000 };
    w.deps.sha256 = async (text) => `h:${text}`;
    const inner = scriptedResponder(() => "green");
    target.responder = (req) =>
      req.system === CHANGE_SYSTEM
        ? {
            ok: true,
            usage: { input: 10, output: 5 },
            model: "m",
            json: {
              material: false,
              category: "other",
              severity: "watch",
              summary: "Routine.",
              evidence_ids: [1],
            },
          }
        : inner(req);
    w.edgar.filings = [];
    w.yahoo.items = Array.from({ length: 60 }, (_, i) => news(i, 300));
    const monitor = new FakeMonitor();
    monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenOld });
    await changeCheck(w, monitor);
    const call = target.calls.find((c) => c.system === CHANGE_SYSTEM);
    assert(call);
    return call;
  };
  const primary = await run(false);
  const alternate = await run(true);
  assertEquals(primary.maxOutputTokens, 1024);
  assert(primary.user.length > 15_000 && primary.user.length <= 16_000);
  assertEquals(alternate.maxOutputTokens, 1024, "the step's own 1,024 is already under the cap");
  assert(requestChars(alternate) <= Math.floor(3000 * CHARS_PER_TOKEN));
  assert(alternate.user.length < primary.user.length);
  assert(alternate.user.includes("further items omitted for length"));
  assertEquals(JSON.stringify(alternate.schema), JSON.stringify(CHANGE_CLASSIFICATION_SCHEMA));
});

Deno.test("change classification on a size-limited provider: too large halves once, then the check ends unacknowledged", async () => {
  const w = makeWorld({ configured: false, alternate: true });
  const alt = w.alt;
  assert(alt);
  alt.budget = GROQ_BUDGET;
  alt.responder = tooLarge;
  w.deps.sha256 = async (text) => `h:${text}`;
  w.edgar.filings = [];
  w.yahoo.items = [news(1)];
  const monitor = new FakeMonitor();
  monitor.addRow({ userId: "u1", securityId: "sec-1", lastReportId: "rep-0", seen: seenOld });
  const res = await changeCheck(w, monitor);
  assertEquals(res.outcome, "llm_invalid");
  assertEquals(alt.calls.length, 2, "full, then halved, then stop");
  assertEquals(monitor.monitorRows[0]?.seen, seenOld);
});
