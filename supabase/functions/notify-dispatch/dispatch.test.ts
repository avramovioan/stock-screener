import type { PushResult, PushTarget, SendPushOptions } from "@adapters/push.ts";
import type { TelegramResult } from "@adapters/telegram.ts";
import type { DiscountEntry } from "@core/digest.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ClaimedDelivery,
  type ClaimedTelegram,
  type Completion,
  type DispatchDeps,
  type DispatchStore,
  MAX_ATTEMPTS,
  processDelivery,
  processTelegram,
  RETRY_SECONDS,
  runDispatch,
  type TelegramCompletion,
} from "./dispatch.ts";

const NOW = Date.parse("2026-10-15T10:30:00Z");
const USER = "00000000-0000-0000-0000-0000000000a1";
const ENTRY: DiscountEntry = {
  episodeId: "e1",
  companyId: "c1",
  securityId: "s1",
  mode: "worldwide",
  alsoIn: [],
  rank: 12,
  yahooSymbol: "AAA",
  name: "Alpha Corp",
  close: 100,
  ccy: "USD",
  sessionDate: "2026-10-14",
  line: "-3",
  isTop10: false,
  reachedLine4: false,
  category: "green",
  conclusion: "Meets these two fundamental checks.",
  bankruptcyRisk: "Low",
  summary: "Fell with the sector.",
  eur: null,
};

function delivery(over: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    id: "del-1",
    digestId: "dig-1",
    userId: USER,
    subscriptionId: null,
    channel: "push",
    attempts: 1,
    idempotencyKey: `digest:discounts:${USER}:2026-10-15`,
    quotaConsumed: false,
    kind: "discounts",
    content: { kind: "discounts", scanDate: "2026-10-15", items: [ENTRY] },
    scanRunId: "run-1",
    digestCreatedAt: "2026-10-15T10:20:00Z",
    scanDate: "2026-10-15",
    prefs: { pushEnabled: true },
    ...over,
  };
}

interface Sub {
  id: string;
  userId: string | null;
  topics: { discounts: boolean; portfolio: boolean };
  endpoint: string;
  p256dh: string;
  auth: string;
  revoked: boolean;
  failures: number;
}

class FakeStore implements DispatchStore {
  completions: { id: string; c: Completion }[] = [];
  subs: Sub[] = [];
  queue: ClaimedDelivery[] = [];
  telegramQueue: ClaimedTelegram[] = [];
  telegramCompletions: { id: string; c: TelegramCompletion }[] = [];
  claimTelegram(limit: number) {
    return Promise.resolve(this.telegramQueue.splice(0, limit));
  }
  completeTelegram(id: string, c: TelegramCompletion) {
    this.telegramCompletions.push({ id, c });
    return Promise.resolve();
  }
  claim(limit: number) {
    return Promise.resolve(this.queue.splice(0, limit));
  }
  subscriptions(userId: string, kind: "discounts" | "portfolio") {
    return Promise.resolve(
      this.subs
        .filter((s) => s.userId === userId && !s.revoked && s.topics[kind])
        .map(({ id, endpoint, p256dh, auth }) => ({ id, endpoint, p256dh, auth })),
    );
  }
  deviceSubscription(id: string) {
    return Promise.resolve(
      this.subs
        .filter((s) => s.id === id && s.userId === null && !s.revoked && s.topics.discounts)
        .map(({ id, endpoint, p256dh, auth }) => ({ id, endpoint, p256dh, auth }))[0] ?? null,
    );
  }
  markSubscription(id: string, outcome: "success" | "failure" | "gone") {
    const s = this.subs.find((x) => x.id === id);
    if (s) {
      if (outcome === "success") s.failures = 0;
      if (outcome === "gone") s.revoked = true;
      if (outcome === "failure" && ++s.failures >= 5) s.revoked = true;
    }
    return Promise.resolve();
  }
  complete(id: string, c: Completion) {
    this.completions.push({ id, c });
    return Promise.resolve();
  }
}

function sub(id: string, over: Partial<Sub> = {}): Sub {
  return {
    id,
    userId: USER,
    topics: { discounts: true, portfolio: true },
    endpoint: `https://push.example.test/${id}`,
    p256dh: "k",
    auth: "a",
    revoked: false,
    failures: 0,
    ...over,
  };
}

function setup(
  over: {
    push?: (t: PushTarget, o: SendPushOptions) => PushResult;
    telegram?: (text: string) => TelegramResult;
  } = {},
) {
  const store = new FakeStore();
  const pushCalls: { endpoint: string; payload: string; opts: SendPushOptions }[] = [];
  const telegramCalls: string[] = [];
  const telegram = over.telegram;
  const deps: DispatchDeps = {
    store,
    telegram:
      telegram === undefined
        ? null
        : {
            send: (text) => {
              telegramCalls.push(text);
              return Promise.resolve(telegram(text));
            },
          },
    sendPush: (t, payload, opts) => {
      pushCalls.push({ endpoint: t.endpoint, payload, opts });
      return Promise.resolve(over.push?.(t, opts) ?? { ok: true });
    },
    nowMs: () => NOW,
    siteUrl: "https://screener.example.test",
    log: () => {},
  };
  return { store, deps, pushCalls, telegramCalls };
}

Deno.test("a retried delivery stays one delivery: same row, same Topic on every attempt", async () => {
  const p = setup({ push: () => ({ ok: false, kind: "network" }) });
  p.store.subs = [sub("s1")];
  const pd = delivery({ id: "del-2" });
  const c1 = await processDelivery(pd, p.deps);
  await processDelivery({ ...pd, attempts: 2 }, p.deps);
  assertEquals([c1.status, c1.retryInSeconds], ["pending", 60]);
  assertEquals(
    p.pushCalls.map((c) => c.opts.topic),
    ["digest-discounts", "digest-discounts"],
  );
});

Deno.test("retry schedule is 1 m, 5 m, 30 m, 2 h and the fifth failed attempt is final", async () => {
  const { store, deps } = setup({ push: () => ({ ok: false, kind: "http", status: 503 }) });
  store.subs = [sub("s1")];
  const seconds: (number | null | undefined)[] = [];
  for (let attempts = 1; attempts <= 4; attempts++)
    seconds.push((await processDelivery(delivery({ attempts }), deps)).retryInSeconds);
  assertEquals(seconds, [60, 300, 1800, 7200]);
  assertEquals([...RETRY_SECONDS], [60, 300, 1800, 7200]);
  const last = await processDelivery(delivery({ attempts: MAX_ATTEMPTS }), deps);
  assertEquals(last.status, "failed");
  assertStringIncludes(last.error ?? "", "attempts_exhausted");
});

Deno.test("a digest older than 24 h expires and is never pushed", async () => {
  const { store, deps, pushCalls } = setup();
  store.subs = [sub("s1")];
  const c = await processDelivery(delivery({ digestCreatedAt: "2026-10-14T09:00:00Z" }), deps);
  assertEquals([c.status, c.error], ["failed", "expired"]);
  assertEquals(pushCalls.length, 0);
});

Deno.test("a leftover e-mail delivery row is skipped, never sent", async () => {
  const { store, deps, pushCalls } = setup();
  store.subs = [sub("s1")];
  const c = await processDelivery(delivery({ channel: "email" }), deps);
  assertEquals([c.status, c.skipReason], ["skipped", "channel_removed"]);
  assertEquals(pushCalls.length, 0);
});

Deno.test("push: sent when one subscription succeeds; a gone subscription is revoked and never used again", async () => {
  const { store, deps, pushCalls } = setup({
    push: (t) =>
      t.endpoint.endsWith("/dead") ? { ok: false, kind: "gone", status: 410 } : { ok: true },
  });
  store.subs = [sub("dead"), sub("live")];
  const d = delivery();
  const first = await processDelivery(d, deps);
  assertEquals(first.status, "sent");
  assertEquals(store.subs.find((s) => s.id === "dead")?.revoked, true);
  assertEquals(pushCalls.length, 2);
  assertEquals(pushCalls[0]?.opts, {
    ttlSeconds: 21600,
    topic: "digest-discounts",
    urgency: "normal",
  });
  await processDelivery({ ...d, id: "del-next", attempts: 1 }, deps);
  assertEquals(
    pushCalls.filter((c) => c.endpoint.endsWith("/dead")).length,
    1,
    "the revoked endpoint is not contacted again",
  );
});

Deno.test("push: all subscriptions gone or none at all is skipped, 429 retries after Retry-After, payload stays small", async () => {
  const gone = setup({ push: () => ({ ok: false, kind: "gone", status: 404 }) });
  gone.store.subs = [sub("x")];
  const c = await processDelivery(delivery(), gone.deps);
  assertEquals([c.status, c.skipReason], ["skipped", "no_subscription"]);
  const none = setup();
  assertEquals((await processDelivery(delivery(), none.deps)).skipReason, "no_subscription");
  const limited = setup({
    push: () => ({ ok: false, kind: "rate_limited", status: 429, retryAfterSec: 900 }),
  });
  limited.store.subs = [sub("x")];
  const r = await processDelivery(delivery(), limited.deps);
  assertEquals([r.status, r.retryInSeconds], ["pending", 900]);
  const ok = setup();
  ok.store.subs = [sub("x")];
  await processDelivery(delivery(), ok.deps);
  assert((ok.pushCalls[0]?.payload.length ?? 0) <= 3500);
});

Deno.test("push: a persistent 4xx counts against the subscription and five failures revoke it", async () => {
  const { store, deps } = setup({ push: () => ({ ok: false, kind: "http", status: 401 }) });
  store.subs = [sub("bad")];
  for (let i = 0; i < 5; i++) {
    const c = await processDelivery(delivery({ id: `d${i}` }), deps);
    assertEquals(c.status, "failed");
  }
  assertEquals(store.subs[0]?.revoked, true);
  assertEquals((await processDelivery(delivery({ id: "d9" }), deps)).skipReason, "no_subscription");
});

Deno.test("push disabled after creation is skipped, not sent", async () => {
  const { store, deps, pushCalls } = setup();
  store.subs = [sub("x")];
  const d = delivery();
  const c = await processDelivery({ ...d, prefs: { ...d.prefs, pushEnabled: false } }, deps);
  assertEquals([c.status, c.skipReason], ["skipped", "preference_off"]);
  assertEquals(pushCalls.length, 0);
});

Deno.test("runDispatch completes every claimed delivery and survives one exception", async () => {
  const { store, deps } = setup();
  store.queue = [delivery({ id: "a" }), delivery({ id: "boom" }), delivery({ id: "c" })];
  const original = store.complete.bind(store);
  store.complete = (id, c) => (id === "boom" ? Promise.reject(new Error("db")) : original(id, c));
  const result = await runDispatch(deps, { limit: 20, budgetMs: 100_000 });
  assertEquals(
    store.completions.map((c) => c.id),
    ["a", "c"],
  );
  assertEquals(result.processed, 2);
  assertEquals(result.errors, 1);
});

Deno.test("push: a 413 payload_too_large does not count against the subscription", async () => {
  const { store, deps } = setup({
    push: () => ({ ok: false, kind: "payload_too_large", status: 413 }),
  });
  store.subs = [sub("big")];
  for (let i = 0; i < 6; i++) {
    const c = await processDelivery(delivery({ id: `d${i}` }), deps);
    assertEquals([c.status, c.error], ["failed", "push_rejected"]);
  }
  assertEquals(store.subs[0]?.failures, 0);
  assertEquals(store.subs[0]?.revoked, false);
});

Deno.test("a user delivery goes only to the devices that have the topic of its kind", async () => {
  const { store, deps, pushCalls } = setup();
  store.subs = [
    sub("a", { topics: { discounts: true, portfolio: false } }),
    sub("b", { topics: { discounts: false, portfolio: true } }),
  ];
  const c = await processDelivery(delivery(), deps);
  assertEquals(c.status, "sent");
  assertEquals(
    pushCalls.map((p) => p.endpoint),
    ["https://push.example.test/a"],
  );
  const none = setup();
  none.store.subs = [sub("b", { topics: { discounts: false, portfolio: true } })];
  const skipped = await processDelivery(delivery(), none.deps);
  assertEquals([skipped.status, skipped.skipReason], ["skipped", "no_subscription"]);
});

Deno.test("a device delivery (public digest) is pushed to its own device only, whatever any user preference", async () => {
  const { store, deps, pushCalls } = setup();
  store.subs = [sub("d1", { userId: null }), sub("d2", { userId: null }), sub("u1")];
  const c = await processDelivery(
    delivery({ userId: null, subscriptionId: "d1", prefs: { pushEnabled: false } }),
    deps,
  );
  assertEquals(c.status, "sent");
  assertEquals(
    pushCalls.map((p) => p.endpoint),
    ["https://push.example.test/d1"],
  );
  assertEquals(pushCalls[0]?.opts.topic, "digest-discounts");
  assertStringIncludes(pushCalls[0]?.payload ?? "", "Today's discounts");
});

Deno.test("a device delivery whose device is gone, revoked, signed in or opted out is skipped, never sent", async () => {
  for (const over of [
    { revoked: true },
    { userId: USER },
    { topics: { discounts: false, portfolio: false } },
  ] as Partial<Sub>[]) {
    const { store, deps, pushCalls } = setup();
    store.subs = [sub("d1", { userId: null, ...over })];
    const c = await processDelivery(delivery({ userId: null, subscriptionId: "d1" }), deps);
    assertEquals([c.status, c.skipReason], ["skipped", "no_subscription"]);
    assertEquals(pushCalls.length, 0);
  }
  const absent = setup();
  const c = await processDelivery(delivery({ userId: null, subscriptionId: "nope" }), absent.deps);
  assertEquals(c.skipReason, "no_subscription");
});

Deno.test("a device delivery that the push service says is gone revokes the device and is skipped", async () => {
  const { store, deps } = setup({ push: () => ({ ok: false, kind: "gone", status: 410 }) });
  store.subs = [sub("d1", { userId: null })];
  const c = await processDelivery(delivery({ userId: null, subscriptionId: "d1" }), deps);
  assertEquals([c.status, c.skipReason], ["skipped", "no_subscription"]);
  assertEquals(store.subs[0]?.revoked, true);
});

// Telegram group: the public digest, one message ----------------------------------------------------------------------------------

function tgDelivery(over: Partial<ClaimedTelegram> = {}): ClaimedTelegram {
  return {
    id: "tg-1",
    digestId: "dig-pub",
    attempts: 1,
    content: { kind: "discounts", scanDate: "2026-10-21", items: [ENTRY] },
    digestCreatedAt: "2026-10-15T10:20:00Z",
    scanDate: "2026-10-21",
    ...over,
  };
}

Deno.test("telegram: a delivery is sent as one HTML message with the scan day and the site link", async () => {
  const { deps, telegramCalls } = setup({ telegram: () => ({ ok: true, messageId: 9 }) });
  const c = await processTelegram(tgDelivery(), deps);
  assertEquals([c.status, c.messageId], ["sent", 9]);
  assertEquals(telegramCalls.length, 1);
  assertStringIncludes(telegramCalls[0] ?? "", "<b>New on the screener · 21 Oct</b>");
  assertStringIncludes(telegramCalls[0] ?? "", "• <b>AAA</b> Alpha Corp · #12 · at its −3 line");
  assertStringIncludes(
    telegramCalls[0] ?? "",
    '<a href="https://screener.example.test">Open the screener</a>',
  );
});

Deno.test("telegram: a digest with no companies sends nothing", async () => {
  const { deps, telegramCalls } = setup({ telegram: () => ({ ok: true, messageId: 1 }) });
  const c = await processTelegram(
    tgDelivery({ content: { kind: "discounts", scanDate: "2026-10-21", items: [] } }),
    deps,
  );
  assertEquals([c.status, c.error], ["skipped", "empty"]);
  assertEquals(telegramCalls.length, 0);
});

Deno.test("telegram: network errors and 5xx retry with the push backoff, then fail after five attempts", async () => {
  for (const result of [
    { ok: false, kind: "network" },
    { ok: false, kind: "server", status: 502 },
  ] as TelegramResult[]) {
    const { deps } = setup({ telegram: () => result });
    const first = await processTelegram(tgDelivery({ attempts: 1 }), deps);
    assertEquals([first.status, first.retryInSeconds], ["pending", RETRY_SECONDS[0]]);
    const last = await processTelegram(tgDelivery({ attempts: MAX_ATTEMPTS }), deps);
    assertEquals(last.status, "failed");
    assert(last.error?.startsWith("attempts_exhausted:"));
  }
});

Deno.test("telegram: a 429 waits at least Telegram's retry_after", async () => {
  const { deps } = setup({
    telegram: () => ({ ok: false, kind: "rate_limited", status: 429, retryAfterSec: 5000 }),
  });
  const c = await processTelegram(tgDelivery(), deps);
  assertEquals([c.status, c.retryInSeconds, c.error], ["pending", 5000, "telegram_429"]);
});

Deno.test("telegram: a 4xx is final, with its status as the error code", async () => {
  const { deps } = setup({
    telegram: () => ({
      ok: false,
      kind: "rejected",
      status: 403,
      description: "Forbidden: bot was kicked",
    }),
  });
  const c = await processTelegram(tgDelivery(), deps);
  assertEquals([c.status, c.error], ["failed", "telegram_403"]);
});

Deno.test("telegram: a digest older than 24 hours expires unsent", async () => {
  const { deps, telegramCalls } = setup({ telegram: () => ({ ok: true, messageId: 1 }) });
  const c = await processTelegram(tgDelivery({ digestCreatedAt: "2026-10-14T10:00:00Z" }), deps);
  assertEquals([c.status, c.error], ["failed", "expired"]);
  assertEquals(telegramCalls.length, 0);
});

Deno.test("telegram: runDispatch claims and records telegram deliveries in the same run as push", async () => {
  const { store, deps, telegramCalls } = setup({ telegram: () => ({ ok: true, messageId: 5 }) });
  store.telegramQueue = [tgDelivery()];
  const r = await runDispatch(deps, { limit: 10, budgetMs: 1000 });
  assertEquals(r, { claimed: 1, processed: 1, errors: 0 });
  assertEquals(telegramCalls.length, 1);
  assertEquals(
    store.telegramCompletions.map((x) => [x.id, x.c.status, x.c.messageId]),
    [["tg-1", "sent", 5]],
  );
});

Deno.test("telegram: when it is not configured nothing is claimed and nothing fails", async () => {
  const { store, deps } = setup();
  store.telegramQueue = [tgDelivery()];
  const r = await runDispatch(deps, { limit: 10, budgetMs: 1000 });
  assertEquals(r, { claimed: 0, processed: 0, errors: 0 });
  assertEquals(store.telegramQueue.length, 1);
});

Deno.test("telegram: an error in one delivery is counted and does not stop the run", async () => {
  const { store, deps } = setup({ telegram: () => ({ ok: true, messageId: 1 }) });
  store.telegramQueue = [tgDelivery({ id: "a" }), tgDelivery({ id: "b" })];
  let n = 0;
  store.completeTelegram = (id, c) => {
    if (n++ === 0) return Promise.reject(new Error("db down"));
    store.telegramCompletions.push({ id, c });
    return Promise.resolve();
  };
  const r = await runDispatch(deps, { limit: 10, budgetMs: 1000 });
  assertEquals(r, { claimed: 2, processed: 1, errors: 1 });
});
