import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFakeClock } from "./clock.ts";
import { createMemoryKv } from "./store.ts";
import {
  BudgetExceededError,
  createKvBreakerStore,
  createThrottle,
  type FetchLike,
  parseRetryAfter,
  YahooUnavailableError,
} from "./throttle.ts";

const ok = () => new Response("{}", { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("x", { status: code, headers });

function harness(responses: Array<Response | Error>, extra: Record<string, unknown> = {}) {
  const clock = createFakeClock();
  const kv = createMemoryKv(clock);
  const calls: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let i = 0;
  const fetchImpl: FetchLike = async () => {
    calls.push(clock.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return (r as Response).clone();
    } finally {
      inFlight--;
    }
  };
  const throttle = createThrottle({
    fetchImpl,
    clock,
    breaker: createKvBreakerStore(kv),
    rng: () => 0.5,
    ...extra,
  });
  return { clock, kv, calls, throttle, inFlight: () => maxInFlight };
}

Deno.test("spacing: starts are at least 340 ms apart and never more than 3 per rolling second", async () => {
  const h = harness([ok()], { rng: () => 0.99 });
  for (let n = 0; n < 24; n++)
    await h.throttle.fetch("https://query1.finance.yahoo.com/v7/finance/quote?symbols=A");
  for (let n = 1; n < h.calls.length; n++)
    assert(h.calls[n]! - h.calls[n - 1]! >= 340, `gap ${h.calls[n]! - h.calls[n - 1]!}`);
  for (let n = 3; n < h.calls.length; n++)
    assert(h.calls[n]! - h.calls[n - 3]! > 1000, "more than 3 requests inside one second");
});

Deno.test("concurrency 1: simultaneous callers are serialised", async () => {
  const h = harness([ok()]);
  await Promise.all(Array.from({ length: 6 }, () => h.throttle.fetch("https://example.test/a")));
  assertEquals(h.calls.length, 6);
  assertEquals(h.inFlight(), 1);
});

Deno.test("429 is retried with backoff and then succeeds; Retry-After is honoured; stats never hold the query string", async () => {
  const h = harness([status(429, { "retry-after": "7" }), status(429), ok()]);
  const res = await h.throttle.fetch("https://example.test/a?crumb=SECRET");
  assertEquals(res.status, 200);
  assertEquals(h.calls.length, 3);
  assert(h.clock.sleeps.includes(7000), "Retry-After of 7 s must be used as the delay");
  const stats = h.throttle.stats();
  assertEquals(stats.status429, 2);
  assertEquals(stats.retries, 2);
  assert(!JSON.stringify(stats).includes("SECRET"));
});

Deno.test("backoff delay is min(30 s, 1 s * 2^(attempt-1)) * U(0.5, 1.5)", async () => {
  const h = harness([status(500), status(500), status(500), ok()], { rng: () => 0.5 });
  await h.throttle.fetch("https://example.test/a");
  // rng 0.5 -> factor 1.0: delays of 1 s, 2 s and 4 s (the pacing sleeps are shorter than 1 s)
  assertEquals(
    h.clock.sleeps.filter((s) => s >= 1000),
    [1000, 2000, 4000],
  );
});

Deno.test("a network error is retried", async () => {
  const h = harness([new TypeError("connection reset"), ok()]);
  const res = await h.throttle.fetch("https://example.test/a");
  assertEquals(res.status, 200);
  assertEquals(h.throttle.stats().networkErrors, 1);
});

Deno.test("404 and 401 are returned immediately without retry", async () => {
  for (const code of [404, 401]) {
    const h = harness([status(code)]);
    const res = await h.throttle.fetch("https://example.test/a");
    assertEquals(res.status, code);
    assertEquals(h.calls.length, 1);
  }
});

Deno.test("5xx exhausts four attempts and returns the last response", async () => {
  const h = harness([status(503)]);
  const res = await h.throttle.fetch("https://example.test/a");
  assertEquals(res.status, 503);
  assertEquals(h.calls.length, 4);
  assertEquals(
    (await h.kv.get<{ consecutiveFailures: number }>("yahoo:breaker"))?.consecutiveFailures,
    4,
  );
});

Deno.test("breaker: the 5th consecutive failure opens it for 10 minutes; later calls fail fast without touching the network", async () => {
  const h = harness([status(429)]);
  await h.throttle.fetch("https://example.test/a"); // attempts 1-4
  const err = await assertRejects(
    () => h.throttle.fetch("https://example.test/a"),
    YahooUnavailableError,
  ); // attempt 5 opens it
  assertEquals(h.calls.length, 5);
  assertEquals(err.untilMs, h.clock.now() + 10 * 60_000);
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  assertEquals(h.calls.length, 5, "no request while open");
  const stored = await h.kv.get<{ openUntilMs: number | null }>("yahoo:breaker");
  assertEquals(stored?.openUntilMs, err.untilMs);
});

Deno.test("breaker half-opens after 10 minutes: a failing trial reopens it at once", async () => {
  const h = harness([status(429)], { budgetMs: 1e12 });
  await h.throttle.fetch("https://example.test/a");
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  h.clock.advance(10 * 60_000 + 1);
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  assertEquals(h.calls.length, 6, "exactly one trial request went out");
});

Deno.test("breaker half-opens after 10 minutes: a successful trial closes it", async () => {
  const h = harness([status(429), status(429), status(429), status(429), status(429), ok()], {
    budgetMs: 1e12,
  });
  await h.throttle.fetch("https://example.test/a");
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  h.clock.advance(10 * 60_000 + 1);
  const res = await h.throttle.fetch("https://example.test/a");
  assertEquals(res.status, 200);
  assertEquals(
    (await h.kv.get<{ openUntilMs: number | null }>("yahoo:breaker"))?.openUntilMs,
    null,
  );
});

Deno.test("breaker state persisted in the store is honoured by a fresh throttle (a new isolate)", async () => {
  const h = harness([status(429)]);
  await h.throttle.fetch("https://example.test/a");
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);

  let calls = 0;
  const second = createThrottle({
    fetchImpl: () => {
      calls++;
      return Promise.resolve(ok());
    },
    clock: h.clock,
    breaker: createKvBreakerStore(h.kv),
  });
  await assertRejects(() => second.fetch("https://example.test/a"), YahooUnavailableError);
  assertEquals(calls, 0);
});

Deno.test("budget: no new request starts after 90 s of wall time", async () => {
  const h = harness([ok()]);
  await h.throttle.fetch("https://example.test/a");
  h.clock.advance(91_000);
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), BudgetExceededError);
});

Deno.test("timeout: a request that never answers is aborted and counted as a network error", async () => {
  const clock = createFakeClock();
  const kv = createMemoryKv(clock);
  const fetchImpl: FetchLike = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  const throttle = createThrottle({
    fetchImpl,
    clock,
    breaker: createKvBreakerStore(kv),
    timeoutMs: 20,
    maxAttempts: 2,
    rng: () => 0.5,
  });
  await assertRejects(() => throttle.fetch("https://example.test/slow"));
  assertEquals(throttle.stats().networkErrors, 2);
});

Deno.test("parseRetryAfter reads seconds and HTTP dates and caps at 60 s", () => {
  assertEquals(parseRetryAfter("7", 0), 7000);
  assertEquals(parseRetryAfter("500", 0), 60_000);
  assertEquals(parseRetryAfter(null, 0), null);
  assertEquals(parseRetryAfter("nonsense", 0), null);
  assertEquals(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
});

Deno.test("kill switch: a disabled provider refuses every request without calling fetch", async () => {
  const clock = createFakeClock();
  let calls = 0;
  let enabled = false;
  const throttle = createThrottle({
    fetchImpl: () => {
      calls++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    clock,
    breaker: createKvBreakerStore(createMemoryKv(clock)),
    isEnabled: () => Promise.resolve(enabled),
  });
  await assertRejects(
    () => throttle.fetch("https://query1.finance.yahoo.com/v7/x"),
    YahooUnavailableError,
  );
  assertEquals(calls, 0);
  enabled = true;
  assertEquals((await throttle.fetch("https://query1.finance.yahoo.com/v7/x")).status, 200);
  assertEquals(calls, 1);
});
