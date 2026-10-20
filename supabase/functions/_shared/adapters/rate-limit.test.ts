import { assertEquals } from "@std/assert";
import { clientIp, createAcceptedIpCounter, withIpRateLimit } from "./rate-limit.ts";

function harness(perMinute = 3) {
  const counters = new Map<string, number>();
  let nowMs = Date.UTC(2026, 9, 15, 7, 0, 10);
  const calls: string[] = [];
  const incr = (key: string): Promise<number> => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return Promise.resolve(n);
  };
  const handler = withIpRateLimit(
    (req) => {
      calls.push(req.method);
      return new Response("ok");
    },
    { fn: "f", perMinute, salt: "salt-salt-salt-salt-salt-salt-12", incr, now: () => nowMs },
  );
  return { handler, counters, calls, advance: (ms: number) => (nowMs += ms) };
}
const req = (headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://f.example/x", { method, headers });

Deno.test("allows perMinute requests then answers 429 with Retry-After and CORS", async () => {
  const h = harness(3);
  for (let i = 0; i < 3; i++)
    assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 200);
  const limited = await h.handler(
    req({ "cf-connecting-ip": "1.1.1.1", origin: "https://site.example" }),
  );
  assertEquals(limited.status, 429);
  assertEquals(Number(limited.headers.get("retry-after")) >= 1, true);
  assertEquals((await limited.json()).error, "rate_limited");
  assertEquals(h.calls.length, 3);
});

Deno.test("buckets are per IP and reset with the minute", async () => {
  const h = harness(1);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 200);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "2.2.2.2" }))).status, 200);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 429);
  h.advance(60_000);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 200);
});

Deno.test("a spoofed left-most x-forwarded-for entry does not change the bucket", async () => {
  const h = harness(1);
  assertEquals((await h.handler(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).status, 200);
  assertEquals((await h.handler(req({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }))).status, 429);
  assertEquals(clientIp(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" })), "9.9.9.9");
  assertEquals(
    clientIp(req({ "cf-connecting-ip": "7.7.7.7", "x-forwarded-for": "1.2.3.4" })),
    "7.7.7.7",
  );
  assertEquals(clientIp(req()), "unknown");
});

Deno.test("preflight requests are never counted, and a counter failure lets the request through", async () => {
  const h = harness(1);
  for (let i = 0; i < 5; i++) assertEquals((await h.handler(req({}, "OPTIONS"))).status, 200);
  assertEquals(h.counters.size, 0);
  const open = withIpRateLimit(() => new Response("ok"), {
    fn: "f",
    perMinute: 1,
    salt: "salt-salt-salt-salt-salt-salt-12",
    incr: () => Promise.reject(new Error("db down")),
  });
  assertEquals((await open(req())).status, 200);
});

Deno.test("an hour window shares one bucket per IP across the hour and resets at the next hour", async () => {
  const counters = new Map<string, number>();
  let nowMs = Date.UTC(2026, 9, 15, 7, 59, 0);
  const expiries: string[] = [];
  const handler = withIpRateLimit(() => new Response("ok"), {
    fn: "research-request",
    window: "hour",
    perMinute: 2,
    salt: "salt-salt-salt-salt-salt-salt-12",
    incr: (key, expires) => {
      expiries.push(expires);
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return Promise.resolve(n);
    },
    now: () => nowMs,
  });
  const r = () => handler(req({ "cf-connecting-ip": "1.1.1.1" }));
  assertEquals((await r()).status, 200);
  nowMs += 30_000;
  assertEquals((await r()).status, 200);
  const limited = await r();
  assertEquals(limited.status, 429);
  assertEquals(Number(limited.headers.get("retry-after")), 30);
  assertEquals(
    [...counters.keys()].every((k) => k.startsWith("rl:research-request:")),
    true,
  );
  assertEquals(expiries[0], new Date(Date.UTC(2026, 9, 15, 9, 0, 0)).toISOString());
  nowMs += 31_000;
  assertEquals((await r()).status, 200);
});

function acceptedHarness(limit = 2) {
  const counters = new Map<string, number>();
  let nowMs = Date.UTC(2026, 9, 15, 7, 10, 0);
  let down = false;
  const counter = createAcceptedIpCounter({
    fn: "research-request",
    window: "hour",
    limit,
    salt: "salt-salt-salt-salt-salt-salt-12",
    read: (key) =>
      down ? Promise.reject(new Error("db")) : Promise.resolve(counters.get(key) ?? 0),
    incr: (key) => {
      if (down) return Promise.reject(new Error("db"));
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return Promise.resolve(n);
    },
    now: () => nowMs,
  });
  return {
    counter,
    counters,
    advance: (ms: number) => (nowMs += ms),
    setDown: (v: boolean) => (down = v),
  };
}

Deno.test("accepted-only counter: checking never counts, only commit does", async () => {
  const h = acceptedHarness(2);
  const r = req({ "cf-connecting-ip": "1.1.1.1" });
  for (let i = 0; i < 5; i++) assertEquals((await h.counter.check(r)).allowed, true);
  assertEquals(h.counters.size, 0);
  await h.counter.commit(r);
  await h.counter.commit(r);
  const blocked = await h.counter.check(r);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.resetAtIso, new Date(Date.UTC(2026, 9, 15, 8, 0, 0)).toISOString());
  assertEquals((await h.counter.check(req({ "cf-connecting-ip": "2.2.2.2" }))).allowed, true);
  h.advance(50 * 60_000);
  assertEquals((await h.counter.check(r)).allowed, true);
});

Deno.test("accepted-only counter fails closed: a counter error rejects instead of allowing", async () => {
  const h = acceptedHarness(2);
  const r = req({ "cf-connecting-ip": "1.1.1.1" });
  h.setDown(true);
  let threw = false;
  try {
    await h.counter.check(r);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  threw = false;
  try {
    await h.counter.commit(r);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
