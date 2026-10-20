import { base64UrlEncode } from "@adapters/encoding.ts";
import type { PushResult, PushTarget } from "@adapters/push.ts";
import { assertEquals } from "@std/assert";
import { handlePushSubscribe, type SubscribeStore, type Topics } from "./handler.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";
const P256DH = base64UrlEncode(new Uint8Array([4, ...new Uint8Array(64).fill(7)]));
const AUTH = base64UrlEncode(new Uint8Array(16).fill(3));
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

class FakeStore implements SubscribeStore {
  upserts: { userId: string | null; endpoint: string; userAgent: string | null; topics: Topics }[] =
    [];
  updates: { userId: string | null; endpoint: string; topics: Topics }[] = [];
  removed: string[] = [];
  marks: { id: string; outcome: string }[] = [];
  rows = new Map<string, Topics>();
  target: (PushTarget & { id: string }) | null = null;
  full = false;
  testAllowed = true;
  upsert(
    userId: string | null,
    sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
    topics: Topics,
  ) {
    if (this.full) return Promise.resolve("too_many" as const);
    this.upserts.push({ userId, endpoint: sub.endpoint, userAgent: sub.userAgent, topics });
    this.rows.set(sub.endpoint, topics);
    return Promise.resolve("ok" as const);
  }
  update(userId: string | null, endpoint: string, topics: Topics) {
    if (!this.rows.has(endpoint)) return Promise.resolve(false);
    this.updates.push({ userId, endpoint, topics });
    this.rows.set(endpoint, topics);
    return Promise.resolve(true);
  }
  status(endpoint: string) {
    return Promise.resolve(this.rows.get(endpoint) ?? null);
  }
  remove(endpoint: string) {
    this.removed.push(endpoint);
    this.rows.delete(endpoint);
    return Promise.resolve();
  }
  claimTest(_endpoint: string) {
    if (!this.testAllowed) return Promise.resolve({ kind: "rate_limited" as const });
    if (this.target === null) return Promise.resolve({ kind: "not_found" as const });
    return Promise.resolve({ kind: "ok" as const, target: this.target });
  }
  mark(id: string, outcome: "success" | "failure" | "gone") {
    this.marks.push({ id, outcome });
    return Promise.resolve();
  }
}

function setup(
  sendTestPush: (s: PushTarget, payload: string) => PushResult = () => ({ ok: true }),
) {
  const store = new FakeStore();
  const sent: { endpoint: string; payload: string }[] = [];
  const deps = {
    store,
    verifyUser: (token: string) =>
      token === "throws"
        ? Promise.reject(new Error("jwks down"))
        : Promise.resolve(token === "good" ? USER : null),
    sendTestPush: (s: PushTarget, payload: string) => {
      sent.push({ endpoint: s.endpoint, payload });
      return Promise.resolve(sendTestPush(s, payload));
    },
    siteUrl: "https://screener.example.test",
    extraHosts: [] as string[],
    maxSubscriptions: 10,
    allowedOrigins: ["https://screener.example.test"],
  };
  return { store, sent, deps };
}

function post(body: unknown, token: string | null = "good", extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "https://screener.example.test",
    "user-agent": "TestBrowser/1.0",
    ...extra,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://f.example/push-subscribe", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
const SUB = {
  action: "subscribe",
  subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
};
const TOPICS_ALL = { discounts: true, portfolio: true };

Deno.test("subscribe without a JWT is anonymous: user_id null, portfolio forced off", async () => {
  const { deps, store } = setup();
  const res = await handlePushSubscribe(post({ ...SUB, topics: TOPICS_ALL }, null), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, topics: { discounts: true, portfolio: false } });
  assertEquals(store.upserts, [
    {
      userId: null,
      endpoint: ENDPOINT,
      userAgent: "TestBrowser/1.0",
      topics: { discounts: true, portfolio: false },
    },
  ]);
});

Deno.test("an invalid or failing JWT is treated as none, never a 401", async () => {
  const { deps, store } = setup();
  assertEquals((await handlePushSubscribe(post(SUB, "forged"), deps)).status, 200);
  assertEquals((await handlePushSubscribe(post(SUB, "throws"), deps)).status, 200);
  assertEquals(
    store.upserts.map((u) => u.userId),
    [null, null],
  );
});

Deno.test("subscribe with a JWT binds the row to the JWT user, never to a user id in the body", async () => {
  const { deps, store } = setup();
  const res = await handlePushSubscribe(
    post({ ...SUB, topics: TOPICS_ALL, userId: "00000000-0000-0000-0000-0000000000b2" }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, topics: TOPICS_ALL });
  assertEquals(store.upserts[0]?.userId, USER);
});

Deno.test("subscribe without topics defaults to discounts only; malformed topics are a 400", async () => {
  const { deps, store } = setup();
  const res = await handlePushSubscribe(post(SUB), deps);
  assertEquals(await res.json(), { ok: true, topics: { discounts: true, portfolio: false } });
  for (const topics of ["x", { discounts: "yes", portfolio: false }, [true], { discounts: true }]) {
    assertEquals((await handlePushSubscribe(post({ ...SUB, topics }), deps)).status, 400);
  }
  assertEquals(store.upserts.length, 1);
});

Deno.test("subscribe validates the endpoint allow-list, key sizes and the per-user cap", async () => {
  const { deps, store } = setup();
  const bad = (sub: unknown) =>
    handlePushSubscribe(post({ action: "subscribe", subscription: sub }), deps);
  assertEquals(
    (await bad({ endpoint: "http://fcm.googleapis.com/x", keys: { p256dh: P256DH, auth: AUTH } }))
      .status,
    400,
  );
  assertEquals(
    (
      await bad({
        endpoint: "https://169.254.169.254/latest",
        keys: { p256dh: P256DH, auth: AUTH },
      })
    ).status,
    400,
  );
  assertEquals(
    (await bad({ endpoint: ENDPOINT, keys: { p256dh: "AAAA", auth: AUTH } })).status,
    400,
  );
  assertEquals(
    (await bad({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: "AAAA" } })).status,
    400,
  );
  assertEquals((await bad({ endpoint: ENDPOINT })).status, 400);
  assertEquals(store.upserts.length, 0);
  store.full = true;
  assertEquals((await handlePushSubscribe(post(SUB), deps)).status, 409);
  assertEquals(await (await handlePushSubscribe(post(SUB), deps)).json(), {
    error: "too_many_subscriptions",
  });
});

Deno.test("update re-binds by endpoint: a JWT binds the user, no JWT makes it anonymous with portfolio off", async () => {
  const { deps, store } = setup();
  store.rows.set(ENDPOINT, { discounts: true, portfolio: false });
  const signed = await handlePushSubscribe(
    post({ action: "update", endpoint: ENDPOINT, topics: TOPICS_ALL }),
    deps,
  );
  assertEquals(signed.status, 200);
  assertEquals(await signed.json(), { ok: true, topics: TOPICS_ALL });
  const anon = await handlePushSubscribe(
    post({ action: "update", endpoint: ENDPOINT, topics: TOPICS_ALL }, null),
    deps,
  );
  assertEquals(await anon.json(), { ok: true, topics: { discounts: true, portfolio: false } });
  assertEquals(
    store.updates.map((u) => u.userId),
    [USER, null],
  );
});

Deno.test("update of an unknown endpoint is a 404 not_found; bad input is a 400", async () => {
  const { deps } = setup();
  const res = await handlePushSubscribe(
    post({ action: "update", endpoint: ENDPOINT, topics: TOPICS_ALL }, null),
    deps,
  );
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "not_found" });
  assertEquals(
    (await handlePushSubscribe(post({ action: "update", endpoint: 5, topics: TOPICS_ALL }), deps))
      .status,
    400,
  );
  assertEquals(
    (await handlePushSubscribe(post({ action: "update", endpoint: ENDPOINT }), deps)).status,
    400,
  );
});

Deno.test("status needs no JWT and reports the topics or an unsubscribed device", async () => {
  const { deps, store } = setup();
  const none = await handlePushSubscribe(
    post({ action: "status", endpoint: ENDPOINT }, null),
    deps,
  );
  assertEquals(await none.json(), { subscribed: false, topics: null });
  store.rows.set(ENDPOINT, { discounts: false, portfolio: false });
  const some = await handlePushSubscribe(
    post({ action: "status", endpoint: ENDPOINT }, null),
    deps,
  );
  assertEquals(await some.json(), {
    subscribed: true,
    topics: { discounts: false, portfolio: false },
  });
});

Deno.test("unsubscribe is keyed by endpoint, works without a JWT and is idempotent", async () => {
  const { deps, store } = setup();
  const body = { action: "unsubscribe", endpoint: ENDPOINT };
  assertEquals((await handlePushSubscribe(post(body, null), deps)).status, 200);
  assertEquals((await handlePushSubscribe(post(body), deps)).status, 200);
  assertEquals(store.removed, [ENDPOINT, ENDPOINT]);
  assertEquals(
    (await handlePushSubscribe(post({ action: "unsubscribe", endpoint: 3 }), deps)).status,
    400,
  );
});

Deno.test("test sends one fixed payload to that endpoint only and records the outcome", async () => {
  const { deps, store, sent } = setup();
  store.target = { id: "s1", endpoint: ENDPOINT, p256dh: "k", auth: "a" };
  const res = await handlePushSubscribe(post({ action: "test", endpoint: ENDPOINT }, null), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, sent: 1, failed: 0 });
  assertEquals(store.marks, [{ id: "s1", outcome: "success" }]);
  assertEquals(sent.length, 1);
  assertEquals(JSON.parse(sent[0]?.payload ?? "{}"), {
    title: "Test notification",
    body: "Push is working on this device.",
    url: "https://screener.example.test/profile/notifications",
    tag: "test",
  });
});

Deno.test("test: a gone endpoint is marked gone and counted as failed", async () => {
  const { deps, store } = setup(() => ({ ok: false, kind: "gone", status: 410 }));
  store.target = { id: "s2", endpoint: ENDPOINT, p256dh: "k", auth: "a" };
  const res = await handlePushSubscribe(post({ action: "test", endpoint: ENDPOINT }), deps);
  assertEquals(await res.json(), { ok: true, sent: 0, failed: 1 });
  assertEquals(store.marks, [{ id: "s2", outcome: "gone" }]);
});

Deno.test("test is rate limited per endpoint (429) and an unknown endpoint is a 404", async () => {
  const { deps, store } = setup();
  store.testAllowed = false;
  const limited = await handlePushSubscribe(
    post({ action: "test", endpoint: ENDPOINT }, null),
    deps,
  );
  assertEquals(limited.status, 429);
  assertEquals((await limited.json()).error, "rate_limited");
  store.testAllowed = true;
  const res = await handlePushSubscribe(post({ action: "test", endpoint: ENDPOINT }, null), deps);
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "not_found" });
  assertEquals(store.marks.length, 0);
});

Deno.test("unknown actions and methods are rejected", async () => {
  const { deps } = setup();
  assertEquals((await handlePushSubscribe(post({ action: "nope" }), deps)).status, 400);
  assertEquals(
    (await handlePushSubscribe(new Request("https://f.example/", { method: "GET" }), deps)).status,
    405,
  );
});

Deno.test("CORS preflight answers 204 and echoes only the configured origin", async () => {
  const { deps } = setup();
  const ok = await handlePushSubscribe(
    new Request("https://f.example/", {
      method: "OPTIONS",
      headers: { origin: "https://screener.example.test" },
    }),
    deps,
  );
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://screener.example.test");
  const other = await handlePushSubscribe(
    new Request("https://f.example/", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
    deps,
  );
  assertEquals(other.headers.get("access-control-allow-origin"), null);
});
