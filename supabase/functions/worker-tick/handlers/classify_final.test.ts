import { assertEquals } from "@std/assert";
import type { ReportPatch } from "../../_shared/adapters/research_types.ts";
import {
  assignDisplayOrder,
  classifyFinalHandler,
  publishFinalHandler,
  researchCoverage,
} from "./classify_final.ts";
import { FakeStore } from "./testing/fake_store.ts";

const job = { id: 1, scan_run_id: "run-1", stage: "classify", key: "classify:final", payload: {} };
const log = async () => {};
const now = () => new Date("2026-10-15T00:00:00.000Z");

async function report(store: FakeStore, sid: string, patch: ReportPatch = {}) {
  const r = await store.createReport({
    idempotencyKey: `k-${sid}`,
    securityId: sid,
    companyId: `co-${sid}`,
    scanRunId: "run-1",
    trigger: "new_discount",
    visibility: patch.visibility ?? "public",
  });
  await store.patchReport(r.id, patch);
  return r;
}

const meets = {
  status: "complete" as const,
  conclusion: "Meets these two fundamental checks." as const,
  materialDamageEstablished: false,
  sufficientEvidence: true,
  completedAt: "2026-10-14T00:00:00.000Z",
};
let nextId = 0;
function card(store: FakeStore, sid: string, rank: number, reportId: string | null = null) {
  store.cards.push({
    id: ++nextId,
    scanRunId: "run-1",
    mode: "worldwide",
    securityId: sid,
    rank,
    symbol: sid.toUpperCase(),
    researchReportId: reportId,
    operationalCategory: "pending",
  });
}

Deno.test("classify:final recomputes every card, orders green, amber, then withheld, and never clears the rest", async () => {
  nextId = 0;
  const store = new FakeStore();
  const a = await report(store, "a", { ...meets, bankruptcyRisk: "Low" });
  const b = await report(store, "b", { ...meets, bankruptcyRisk: "Moderate" });
  const c = await report(store, "c", {
    ...meets,
    conclusion: "Does not meet one or both checks.",
    bankruptcyRisk: "High",
    materialDamageEstablished: true,
  });
  const d = await report(store, "d", { status: "failed", error: "unknown_evidence_id" });
  const h = await report(store, "h", { status: "quota_deferred", error: "llm_quota" });
  await report(store, "f", {
    ...meets,
    bankruptcyRisk: "Low",
    isCurrent: true,
    completedAt: "2026-08-20T00:00:00.000Z",
  });
  await report(store, "g", {
    ...meets,
    bankruptcyRisk: "Low",
    isCurrent: true,
    visibility: "holders",
  });
  card(store, "a", 5, a.id);
  card(store, "b", 3, b.id);
  card(store, "c", 1, c.id);
  card(store, "d", 2, d.id);
  card(store, "e", 4);
  card(store, "f", 9);
  card(store, "g", 7);
  card(store, "h", 8, h.id);
  const fresh = await report(store, "i", {
    ...meets,
    bankruptcyRisk: "Low",
    isCurrent: true,
    completedAt: "2026-10-10T00:00:00.000Z",
  });
  card(store, "i", 6);

  await classifyFinalHandler({ store, log, now })(job);
  const by = (sid: string) => store.cards.find((x) => x.securityId === sid);
  assertEquals(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => by(s)?.operationalCategory),
    ["green", "amber", "red", "grey", "pending", "pending", "pending", "pending"],
  );
  assertEquals(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => by(s)?.withheld),
    [false, false, true, true, true, true, true, true],
  );
  assertEquals(by("c")?.categoryReason, "bankruptcy_high");
  assertEquals(by("d")?.categoryReason, "research_failed");
  assertEquals(by("h")?.categoryReason, "research_quota_deferred");
  assertEquals(
    ["e", "f", "g"].map((s) => by(s)?.categoryReason),
    ["not_requested", "not_requested", "not_requested"],
    "no report (or only a stale or holders-only one) and nothing in flight: not requested",
  );
  assertEquals(
    by("f")?.researchReportId,
    null,
    "a public report older than the reuse window never clears a new card (A-27, financial safety)",
  );
  assertEquals([by("i")?.researchReportId, by("i")?.operationalCategory], [fresh.id, "green"]);
  assertEquals(
    by("g")?.researchReportId,
    null,
    "a holders-only report is never copied onto a public card",
  );
  assertEquals(
    ["a", "i", "b", "c", "d", "e", "g", "h", "f"].map((s) => by(s)?.displayOrder),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

Deno.test("assignDisplayOrder orders per mode by category, rank, symbol", () => {
  const order = assignDisplayOrder([
    { id: 1, mode: "us", rank: 2, symbol: "B", category: "amber" },
    { id: 2, mode: "us", rank: 2, symbol: "A", category: "green" },
    { id: 3, mode: "us", rank: 1, symbol: "Z", category: "pending" },
    { id: 4, mode: "worldwide", rank: 9, symbol: "Q", category: "red" },
  ]);
  assertEquals([order.get(2), order.get(1), order.get(3), order.get(4)], [1, 2, 3, 1]);
});

Deno.test("publish:final merges coverage.research and refreshes the scan status", async () => {
  nextId = 0;
  const store = new FakeStore();
  const a = await report(store, "a", { ...meets, bankruptcyRisk: "Low", scanRunId: "run-0" });
  const h = await report(store, "h", {
    status: "quota_deferred",
    error: "provider_not_configured",
  });
  const d = await report(store, "d", { status: "quota_deferred", error: "llm_quota" });
  card(store, "a", 1, a.id);
  card(store, "h", 2, h.id);
  card(store, "d", 3, d.id);
  card(store, "e", 4);
  const coverage = await researchCoverage(store, "run-1");
  assertEquals(coverage, {
    cards: 4,
    complete: 1,
    pending: 0,
    deferred: 1,
    quota_deferred: 2,
    failed: 0,
    not_configured: 1,
    reused: 1,
  });
  await publishFinalHandler({ store, log, now })({
    ...job,
    key: "publish:final",
    stage: "publish",
  });
  assertEquals((store.coverage.get("run-1") as { research: unknown }).research, coverage);
  assertEquals(store.refreshed, ["run-1"]);
});

Deno.test("researchCoverage counts a security once even when it is a card in both modes", async () => {
  nextId = 0;
  const store = new FakeStore();
  card(store, "a", 1);
  store.cards.push({ ...store.cards[0], id: ++nextId, mode: "us" });
  const coverage = await researchCoverage(store, "run-1");
  assertEquals(coverage.cards, 1);
});

Deno.test("classify:final fails a report stuck in running for more than 6 hours: the card ends grey research_failed", async () => {
  nextId = 0;
  const store = new FakeStore();
  const stuck = await report(store, "s", { status: "running", step: "extract:2" });
  const busy = await report(store, "t", { status: "running", step: "extract:1" });
  await store.patchReport(stuck.id, { updatedAt: "2026-10-14T10:00:00.000Z" });
  await store.patchReport(busy.id, { updatedAt: "2026-10-14T20:00:00.000Z" });
  card(store, "s", 1, stuck.id);
  card(store, "t", 2, busy.id);
  await classifyFinalHandler({ store, log, now })(job);
  assertEquals(store.reports.get(stuck.id)?.status, "failed");
  assertEquals(store.reports.get(stuck.id)?.error, "stale_running");
  assertEquals(store.reports.get(busy.id)?.status, "running", "recent progress is left alone");
  const by = (sid: string) => store.cards.find((x) => x.securityId === sid);
  assertEquals(
    [by("s")?.operationalCategory, by("s")?.categoryReason],
    ["grey", "research_failed"],
  );
  assertEquals(by("t")?.operationalCategory, "pending");
});

Deno.test("classify:final keeps research_pending for an unlinked card whose report is in flight", async () => {
  nextId = 0;
  const store = new FakeStore();
  await report(store, "r", { status: "running" });
  await report(store, "w", { status: "queued", waitReason: "weekend" });
  await report(store, "q", { status: "queued" });
  card(store, "r", 1);
  card(store, "w", 2);
  card(store, "n", 3);
  card(store, "q", 4);
  await classifyFinalHandler({ store, log, now })(job);
  const by = (sid: string) => store.cards.find((x) => x.securityId === sid);
  assertEquals(
    ["r", "w", "n", "q"].map((s) => [by(s)?.operationalCategory, by(s)?.categoryReason]),
    [
      ["pending", "research_pending"],
      ["pending", "research_pending"],
      ["pending", "not_requested"],
      ["pending", "research_pending"],
    ],
  );
});
