import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type DigestStore,
  type DigestUser,
  type DiscountRow,
  type InsertDigestArgs,
  type InsertPublicDigestArgs,
  type PortfolioCandidates,
  runDigestStage,
  sha256Hex,
} from "./digest-stage.ts";

const RUN = "run-1";
const U1 = "00000000-0000-0000-0000-0000000000a1";
const U2 = "00000000-0000-0000-0000-0000000000b2";

function user(over: Partial<DigestUser> = {}): DigestUser {
  return {
    userId: U1,
    pushEnabled: true,
    hasActivePush: true,
    hasDiscountsPush: true,
    hasPortfolioPush: true,
    modes: ["worldwide"],
    sendEmpty: false,
    holdsPositions: false,
    ...over,
  };
}
function row(over: Partial<DiscountRow> = {}): DiscountRow {
  return {
    episodeId: "ep-1",
    companyId: "co-1",
    securityId: "sec-1",
    mode: "worldwide",
    rank: 12,
    yahooSymbol: "AAA",
    exchangeCode: "NMS",
    name: "Alpha Corp",
    close: 100,
    currency: "USD",
    sessionDate: "2026-10-14",
    thresholdLine: "-3",
    isTop10: false,
    reachedLine4: false,
    category: "green",
    conclusion: "Meets these two fundamental checks.",
    bankruptcyRisk: "Low",
    summary: "s",
    eurSymbol: null,
    eurStatus: null,
    ...over,
  };
}

class FakeStore implements DigestStore {
  users_: DigestUser[] = [user()];
  discounts = new Map<string, DiscountRow[]>();
  portfolio = new Map<string, PortfolioCandidates>();
  inserted: InsertDigestArgs[] = [];
  keys = new Set<string>();
  finished = 0;
  status = "complete";
  digestsCreatedAt: string | null = null;
  finishedOnlyCalls: boolean[] = [];
  failUser: string | null = null;
  publicRows: DiscountRow[] = [];
  publicInserted: InsertPublicDigestArgs[] = [];
  publicExists = false;
  publicFails = false;
  publicCalls = 0;
  publicCandidates() {
    this.publicCalls++;
    return Promise.resolve(this.publicRows);
  }
  insertPublicDigest(args: InsertPublicDigestArgs) {
    if (this.publicFails) return Promise.reject(new Error("db down"));
    if (this.publicExists) return Promise.resolve(null);
    this.publicInserted.push(args);
    return Promise.resolve("public-1");
  }
  scanRun() {
    return Promise.resolve({
      id: RUN,
      status: this.status,
      scanDateLocal: "2026-10-15",
      digestsCreatedAt: this.digestsCreatedAt,
    });
  }
  getUsers() {
    return Promise.resolve(this.users_);
  }
  publicDiscountCandidates(_run: string) {
    return this.publicCandidates();
  }
  discountCandidates(_run: string, userId: string, finishedOnly: boolean) {
    this.finishedOnlyCalls.push(finishedOnly);
    return Promise.resolve(this.discounts.get(userId) ?? []);
  }
  portfolioCandidates(_run: string, userId: string) {
    return Promise.resolve(this.portfolio.get(userId) ?? { premium: [], risks: [] });
  }
  insertDigest(args: InsertDigestArgs) {
    if (this.failUser === args.userId) return Promise.reject(new Error("db down"));
    const key = `${args.scanRunId}|${args.kind}|${args.userId}`;
    if (this.keys.has(key)) return Promise.resolve(null);
    this.keys.add(key);
    this.inserted.push(args);
    return Promise.resolve(`digest-${this.inserted.length}`);
  }
  finish() {
    this.finished++;
    this.digestsCreatedAt = "2026-10-15T09:00:00Z";
    return Promise.resolve(true);
  }
}
const deps = (store: FakeStore) => ({ store, sha256Hex, log: () => {} });

Deno.test("builds the discounts digest in green-then-amber order and creates one push delivery", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [
    row({ episodeId: "amber", companyId: "c2", category: "amber", rank: 1, yahooSymbol: "AMB" }),
    row({ episodeId: "green", companyId: "c1", rank: 30, yahooSymbol: "GRN" }),
  ]);
  const result = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(result.status, "created");
  assertEquals(store.inserted.length, 1);
  const digest = store.inserted[0];
  assert(digest);
  assertEquals(digest.kind, "discounts");
  assertEquals(digest.reason, "complete");
  assertEquals(digest.status, "ready");
  assertEquals(digest.scanDate, "2026-10-15");
  assertEquals(
    (digest.content.items as { episodeId: string }[]).map((i) => i.episodeId),
    ["green", "amber"],
  );
  assertEquals(
    digest.items.map((i) => `${i.ref_type}:${i.ref_id}`),
    ["episode:green", "episode:amber"],
  );
  assertEquals(digest.channels, [{ channel: "push", status: "pending", skip_reason: null }]);
  assertEquals(digest.hash.length, 64);
  assertEquals(store.finished, 1);
});

Deno.test("every candidate reaches the digest whatever its research state; pending becomes not researched", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [
    row({ episodeId: "ok" }),
    row({
      episodeId: "p",
      companyId: "c2",
      category: null,
      conclusion: null,
      bankruptcyRisk: null,
    }),
    row({ episodeId: "r", companyId: "c3", category: "red" }),
    row({ episodeId: "x", companyId: "c4", category: "pending" }),
  ]);
  await runDigestStage(RUN, "complete", deps(store));
  assertEquals(store.inserted[0]?.items.map((i) => i.ref_id).sort(), ["ok", "p", "r", "x"]);
  const items = (store.inserted[0]?.content.items ?? []) as {
    episodeId: string;
    category: unknown;
  }[];
  assertEquals(items.find((i) => i.episodeId === "p")?.category, null);
  assertEquals(items.find((i) => i.episodeId === "x")?.category, null);
  assertEquals(items.find((i) => i.episodeId === "r")?.category, "red");
});

Deno.test("the digest entry carries the home ticker of the listing", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [
    row({ episodeId: "fr", companyId: "c-fr", yahooSymbol: "RMS.PA", exchangeCode: "PAR" }),
    row({
      episodeId: "us",
      companyId: "c-us",
      yahooSymbol: "BRK.B",
      exchangeCode: "NYQ",
      rank: 13,
    }),
  ]);
  await runDigestStage(RUN, "complete", deps(store));
  const items = (store.inserted[0]?.content.items ?? []) as { episodeId: string; ticker: string }[];
  assertEquals(items.find((i) => i.episodeId === "fr")?.ticker, "RMS");
  assertEquals(items.find((i) => i.episodeId === "us")?.ticker, "BRK.B");
});

Deno.test("a digest is not created twice: re-running inserts nothing and a created scan is a no-op", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [row()]);
  await runDigestStage(RUN, "complete", deps(store));
  const again = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(again.status, "skipped_already_created");
  assertEquals(store.inserted.length, 1);
  store.digestsCreatedAt = null; // simulate a crash before finish: the unique key makes the retry a no-op
  const retry = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(retry.status, "created");
  assertEquals(store.inserted.length, 1);
});

Deno.test("the digest does not wait for research: finishedOnly is false at the cut-off too", async () => {
  const store = new FakeStore();
  await runDigestStage(RUN, "cutoff", deps(store));
  assertEquals(store.finishedOnlyCalls, [false]);
  const other = new FakeStore();
  await runDigestStage(RUN, "complete", deps(other));
  assertEquals(other.finishedOnlyCalls, [false]);
  assertEquals(
    store.inserted[0]?.status,
    "skipped",
    "an empty digest is recorded as skipped, never as ready",
  );
});

Deno.test("empty digest: recorded as skipped without deliveries unless send_empty", async () => {
  const store = new FakeStore();
  await runDigestStage(RUN, "complete", deps(store));
  const skipped = store.inserted[0];
  assertEquals(skipped?.status, "skipped");
  assertEquals(skipped?.skipReason, "empty");
  assertEquals(skipped?.channels, []);
  const withEmpty = new FakeStore();
  withEmpty.users_ = [user({ sendEmpty: true })];
  await runDigestStage(RUN, "complete", deps(withEmpty));
  assertEquals(withEmpty.inserted[0]?.status, "ready");
  assertEquals(withEmpty.inserted[0]?.channels.length, 1);
});

Deno.test("channel rules: disabled and no subscription are recorded as skipped", async () => {
  const store = new FakeStore();
  store.users_ = [user({ hasActivePush: false, hasDiscountsPush: false })];
  store.discounts.set(U1, [row()]);
  await runDigestStage(RUN, "complete", deps(store));
  assertEquals(store.inserted[0]?.channels, [
    { channel: "push", status: "skipped", skip_reason: "no_subscription" },
  ]);
  const off = new FakeStore();
  off.users_ = [user({ pushEnabled: false })];
  off.discounts.set(U1, [row()]);
  await runDigestStage(RUN, "complete", deps(off));
  assertEquals(off.inserted[0]?.channels[0], {
    channel: "push",
    status: "skipped",
    skip_reason: "preference_off",
  });
});

Deno.test("merges modes per company and marks the merged-away episode in digest_items", async () => {
  const store = new FakeStore();
  store.users_ = [user({ modes: ["worldwide", "us"] })];
  store.discounts.set(U1, [
    row({ episodeId: "us-ep", mode: "us", rank: 9, thresholdLine: "-3" }),
    row({ episodeId: "ww-ep", mode: "worldwide", rank: 14 }),
  ]);
  await runDigestStage(RUN, "complete", deps(store));
  const digest = store.inserted[0];
  assertEquals(
    ((digest?.content.items ?? []) as { episodeId: string }[]).map((i) => i.episodeId),
    ["ww-ep"],
  );
  assertEquals(digest?.items.map((i) => i.ref_id).sort(), ["us-ep", "ww-ep"]);
  assertEquals(digest?.items.find((i) => i.ref_id === "us-ep")?.payload, { mergedInto: "ww-ep" });
});

Deno.test("portfolio: only for holders, one entry for a premium event plus a risk finding of one security", async () => {
  const store = new FakeStore();
  store.users_ = [user({ holdsPositions: true }), user({ userId: U2, holdsPositions: false })];
  const candidates: PortfolioCandidates = {
    premium: [
      {
        episodeId: "pe-1",
        securityId: "s9",
        yahooSymbol: "ZZZ",
        name: "Zeta",
        kind: "premium1",
        close: 12.3,
        ccy: "USD",
        sessionDate: "2026-10-14",
        researchStatus: "complete",
      },
    ],
    risks: [
      {
        id: "f-1",
        securityId: "s9",
        yahooSymbol: "ZZZ",
        name: "Zeta",
        category: "liquidity_debt",
        summary: "Covenant breach.",
        detectedOn: "2026-10-14",
        researchStatus: "complete",
      },
    ],
  };
  store.portfolio.set(U1, candidates);
  store.portfolio.set(U2, candidates);
  await runDigestStage(RUN, "complete", deps(store));
  const portfolio = store.inserted.filter((d) => d.kind === "portfolio");
  assertEquals(portfolio.length, 1, "the non-holder gets no portfolio digest");
  const only = portfolio[0];
  assertEquals(((only?.content.items ?? []) as unknown[]).length, 1);
  assertEquals(only?.items.map((i) => `${i.ref_type}:${i.ref_id}`).sort(), [
    "episode:pe-1",
    "finding:f-1",
  ]);
});

Deno.test("portfolio: a holder with no premium events or risks (empty broker_positions) is recorded as skipped", async () => {
  const store = new FakeStore();
  store.users_ = [user({ holdsPositions: true })];
  await runDigestStage(RUN, "complete", deps(store));
  const portfolio = store.inserted.find((d) => d.kind === "portfolio");
  assertEquals(portfolio?.status, "skipped");
  assertEquals(portfolio?.channels, []);
});

Deno.test("one failing user does not block the others, but the scan is not marked finished", async () => {
  const store = new FakeStore();
  store.users_ = [user(), user({ userId: U2 })];
  store.discounts.set(U1, [row()]);
  store.discounts.set(U2, [row()]);
  store.failUser = U1;
  await assertRejects(() => runDigestStage(RUN, "complete", deps(store)), Error, "1 of 2");
  assertEquals(
    store.inserted.map((d) => d.userId),
    [U2],
  );
  assertEquals(store.finished, 0);
});

Deno.test("a failed scan produces no digest", async () => {
  const store = new FakeStore();
  store.status = "failed";
  const result = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(result.status, "skipped_failed_scan");
  assertEquals(store.inserted.length, 0);
});

Deno.test("carries the tag inputs (is_top10, reached_line4) from the candidate row into the digest entry", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [
    row({ episodeId: "top", companyId: "c-top", rank: 3, isTop10: true, reachedLine4: false }),
    row({ episodeId: "deep", companyId: "c-deep", rank: 40, isTop10: false, reachedLine4: true }),
    row({ episodeId: "wait", companyId: "c-wait", rank: 41, isTop10: false, reachedLine4: false }),
  ]);
  await runDigestStage(RUN, "complete", deps(store));
  const items = (store.inserted[0]?.content.items ?? []) as Array<{
    episodeId: string;
    isTop10: boolean;
    reachedLine4: boolean;
    line: string;
  }>;
  assertEquals(items.map((i) => [i.episodeId, i.isTop10, i.reachedLine4, i.line]).sort(), [
    ["deep", false, true, "-3"],
    ["top", true, false, "-3"],
    ["wait", false, false, "-3"],
  ]);
});

Deno.test("portfolio and discount channels follow the topic of their own kind", async () => {
  const store = new FakeStore();
  store.users_ = [user({ holdsPositions: true, hasDiscountsPush: true, hasPortfolioPush: false })];
  store.discounts.set(U1, [row()]);
  store.portfolio.set(U1, {
    premium: [],
    risks: [
      {
        id: "f1",
        securityId: "s1",
        yahooSymbol: "AAA",
        name: "Alpha",
        category: "liquidity_debt",
        summary: "x",
        detectedOn: "2026-10-14",
        researchStatus: "complete",
      },
    ],
  });
  await runDigestStage(RUN, "complete", deps(store));
  const by = (k: string) => store.inserted.find((d) => d.kind === k);
  assertEquals(by("discounts")?.channels, [
    { channel: "push", status: "pending", skip_reason: null },
  ]);
  assertEquals(by("portfolio")?.channels, [
    { channel: "push", status: "skipped", skip_reason: "no_subscription" },
  ]);
});

Deno.test("the public digest is built once per run from the public candidates, whatever the users", async () => {
  const store = new FakeStore();
  store.users_ = [];
  store.publicRows = [
    row({ episodeId: "p1", companyId: "c1", rank: 2, isTop10: true }),
    row({ episodeId: "p2", companyId: "c2", rank: 30, yahooSymbol: "BBB" }),
  ];
  const result = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(result.publicDigest, "created");
  assertEquals(store.publicInserted.length, 1);
  const d = store.publicInserted[0];
  assert(d);
  assertEquals(d.scanRunId, RUN);
  assertEquals(d.status, "ready");
  assertEquals(d.skipReason, null);
  assertEquals(d.reason, "complete");
  assertEquals(d.scanDate, "2026-10-15");
  assertEquals(d.hash.length, 64);
  assertEquals(
    (d.content.items as { episodeId: string }[]).map((i) => i.episodeId),
    ["p1", "p2"],
  );
  assertEquals(d.content.kind, "discounts");
  assertEquals(store.finished, 1);
});

Deno.test("an empty public digest is recorded as skipped (nothing is delivered), an existing one is left alone", async () => {
  const empty = new FakeStore();
  const r1 = await runDigestStage(RUN, "complete", deps(empty));
  assertEquals(r1.publicDigest, "skipped_empty");
  assertEquals(empty.publicInserted[0]?.status, "skipped");
  assertEquals(empty.publicInserted[0]?.skipReason, "empty");
  const again = new FakeStore();
  again.publicRows = [row()];
  again.publicExists = true;
  assertEquals((await runDigestStage(RUN, "cutoff", deps(again))).publicDigest, "existing");
});

Deno.test("a failing public digest fails the job for a retry and the run is not marked finished", async () => {
  const store = new FakeStore();
  store.publicRows = [row()];
  store.publicFails = true;
  await assertRejects(() => runDigestStage(RUN, "complete", deps(store)), Error, "public digest");
  assertEquals(store.finished, 0);
});

Deno.test("a failed or already finished run builds no public digest", async () => {
  const failed = new FakeStore();
  failed.status = "failed";
  await runDigestStage(RUN, "complete", deps(failed));
  const done = new FakeStore();
  done.digestsCreatedAt = "2026-10-15T09:00:00Z";
  await runDigestStage(RUN, "complete", deps(done));
  assertEquals(failed.publicCalls + done.publicCalls, 0);
});
