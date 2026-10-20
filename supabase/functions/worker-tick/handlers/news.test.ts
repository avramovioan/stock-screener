import { assert, assertEquals } from "@std/assert";
import type { Job } from "../../_shared/adapters/research_types.ts";
import { newsHandler } from "./news.ts";
import { makeWorld, SEC_1 } from "./testing/fakes.ts";

const job = (): Job => ({
  id: 1,
  scan_run_id: "run-1",
  stage: "news",
  key: "news:sec-1",
  payload: { security_id: "sec-1", scan_run_id: "run-1", scan_date_local: "2026-10-15" },
});
const ctx = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const item = (uuid: string, related: string[]) => ({
  uuid,
  title: `Story ${uuid}`,
  link: `https://finance.yahoo.com/n/${uuid}`,
  providerPublishTime: "2026-10-14T10:00:00Z",
  relatedTickers: related,
});

Deno.test("news: Yahoo items are filtered by relatedTickers, EDGAR forms recorded, the items stored and no report created", async () => {
  const w = makeWorld();
  w.yahoo.items = [item("a", ["ACME", "OTHER"]), item("b", ["OTHER"]), item("c", ["ACME"])];
  const res = (await newsHandler(w.deps)(job(), ctx())) as {
    yahoo: number;
    edgar: number;
  };
  assertEquals([res.yahoo, res.edgar], [2, 3]);
  assertEquals(w.yahoo.calls, ["ACME"]);
  const latest = w.store.monitorLatest.get("sec-1");
  assertEquals([latest?.yahoo.length, latest?.edgar.length, latest?.rss.length], [2, 3, 0]);
  assertEquals(
    [...w.store.reports.values()].length,
    0,
    "a pending card does not get a report from the news stage",
  );
  assertEquals(
    w.store.cards[0]?.operationalCategory,
    "pending",
    "the card is not touched by the news stage",
  );
  assertEquals(w.store.cards[0]?.researchReportId, null);
});

Deno.test("news: a non-US symbol skips Yahoo, uses RSS, and rerunning creates no report", async () => {
  const w = makeWorld({
    security: {
      ...SEC_1,
      ticker: "SAP.DE",
      secCik: null,
      irRssUrls: ["https://ir.example.com/feed.xml"],
    },
  });
  w.fetch.feedItems = [
    {
      guid: "g1",
      title: "IR item",
      link: "https://ir.example.com/1",
      published: "2026-10-14T00:00:00.000Z",
    },
  ];
  const handler = newsHandler(w.deps);
  await handler(job(), ctx());
  await handler(job(), ctx());
  assertEquals(w.yahoo.calls, []);
  assertEquals(w.edgar.calls, []);
  assertEquals([...w.store.reports.values()].length, 0);
  assertEquals(w.store.monitorLatest.get("sec-1")?.rss.length, 1);
});

Deno.test("news: no report is attached when a reusable current report exists or one is already running", async () => {
  const w = makeWorld();
  const current = await w.store.createReport({
    idempotencyKey: "k",
    securityId: "sec-1",
    companyId: "co-1",
    scanRunId: "old",
    trigger: "new_discount",
    visibility: "public",
  });
  await w.store.patchReport(current.id, {
    status: "complete",
    isCurrent: true,
    completedAt: "2026-10-10T00:00:00.000Z",
  });
  await newsHandler(w.deps)(job(), ctx());
  assertEquals([...w.store.reports.values()].length, 1);
  assert(
    w.store.monitorLatest.has("sec-1"),
    "latest items are still recorded for the change check",
  );
});

Deno.test("news: a failing source is logged and does not fail the job", async () => {
  const w = makeWorld();
  w.yahoo.fail = true;
  const res = (await newsHandler(w.deps)(job(), ctx())) as { edgar: number };
  assertEquals(res.edgar, 3);
  assert(w.logs.some((l) => l.event === "news_source_failed" && l.data?.source === "yahoo"));
});
