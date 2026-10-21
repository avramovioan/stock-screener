import { assertEquals, assertRejects } from "@std/assert";
import type { PushResult, PushTarget } from "../../_shared/adapters/push.ts";
import { pushTest } from "./push_test.ts";

type Device = PushTarget & { id: string };
const dev = (n: number): Device => ({
  id: `id${n}`,
  endpoint: `https://push.example/${n}`,
  p256dh: "k",
  auth: "a",
});

function harness(opts: {
  config?: { configured: boolean; problem: string | null };
  claim?: unknown;
  results?: Array<PushResult | Error>;
}) {
  const marks: Array<[string, string]> = [];
  const payloads: string[] = [];
  let i = 0;
  const deps = {
    siteUrl: "https://site.example/",
    checkConfig: () => Promise.resolve(opts.config ?? { configured: true, problem: null }),
    sb: {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        if (fn === "push_claim_test")
          return Promise.resolve({
            data: opts.claim ?? { status: "ok", devices: [dev(1)] },
            error: null,
          });
        if (fn === "notify_mark_subscription") {
          marks.push([String(args?.p_id), String(args?.p_outcome)]);
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.reject(new Error(`unexpected rpc ${fn}`));
      },
    } as never,
    sendPush: (_t: PushTarget, payload: string) => {
      payloads.push(payload);
      const r = (opts.results ?? [{ ok: true }])[i++] ?? { ok: true };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r as PushResult);
    },
  };
  return { deps, marks, payloads };
}

Deno.test("push_test: misconfigured keys answer server_keys and never claim the rate limit", async () => {
  const h = harness({ config: { configured: false, problem: "key_mismatch" } });
  const r = await pushTest(h.deps);
  assertEquals(r, { ok: false, reason: "server_keys", problem: "key_mismatch" });
  assertEquals(h.payloads.length, 0);
});

Deno.test("push_test: inside the five minutes it answers rate_limited with the wait", async () => {
  const h = harness({ claim: { status: "rate_limited", retry_after_seconds: 120 } });
  assertEquals(await pushTest(h.deps), {
    ok: false,
    reason: "rate_limited",
    retry_after_seconds: 120,
  });
  assertEquals(h.payloads.length, 0);
});

Deno.test("push_test: sends the same payload as push-subscribe and counts sent, failed and gone", async () => {
  const h = harness({
    claim: { status: "ok", devices: [dev(1), dev(2), dev(3), dev(4), dev(5), dev(6)] },
    results: [
      { ok: true },
      { ok: false, kind: "gone", status: 410 },
      { ok: false, kind: "http", status: 403 },
      { ok: false, kind: "rate_limited", status: 429 },
      { ok: false, kind: "network" },
      new Error("keys"),
    ],
  });
  const r = await pushTest(h.deps);
  assertEquals(r, {
    ok: true,
    devices: 6,
    sent: 1,
    failed: 4,
    gone: 1,
    reasons: { rejected: { "403": 1, "429": 1 }, network: 1, server_keys: 1 },
  });
  assertEquals(JSON.parse(h.payloads[0] ?? "{}"), {
    title: "Test notification",
    body: "Push is working on this device.",
    url: "https://site.example/profile/notifications",
    tag: "test",
  });
  assertEquals(h.marks, [
    ["id1", "success"],
    ["id2", "gone"],
    ["id3", "failure"],
    ["id4", "failure"],
    ["id5", "failure"],
    ["id6", "failure"],
  ]);
  assertEquals(JSON.stringify(r).includes("push.example"), false);
});

Deno.test("push_test: no devices is a clean answer", async () => {
  const h = harness({ claim: { status: "ok", devices: [] } });
  assertEquals(await pushTest(h.deps), {
    ok: true,
    devices: 0,
    sent: 0,
    failed: 0,
    gone: 0,
    reasons: {},
  });
});

Deno.test("push_test: a database error is thrown", async () => {
  const h = harness({});
  const deps = {
    ...h.deps,
    sb: { rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) } as never,
  };
  await assertRejects(() => pushTest(deps), Error, "boom");
});
