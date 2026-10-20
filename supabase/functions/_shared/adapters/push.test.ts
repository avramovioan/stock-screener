import * as webpush from "jsr:@negrel/webpush@0.5.0";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { base64UrlEncode } from "./encoding.ts";
import { isAllowedPushEndpoint, loadPushEnv, type PushEnv, sendPush } from "./push.ts";

async function makeEnv(): Promise<PushEnv> {
  const keys = await webpush.generateVapidKeys({ extractable: true });
  const exported = await webpush.exportVapidKeys(keys);
  return {
    publicKey: await webpush.exportApplicationServerKey(keys),
    privateKeyJwk: JSON.stringify(exported.privateKey),
    subject: "mailto:ops@example.test",
  };
}

async function makeSubscription(endpoint = "https://push.example.test/send/abc") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    endpoint,
    p256dh: base64UrlEncode(raw),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array();
}

function fakeFetch(respond: (n: number) => Response | Error) {
  const calls: Captured[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const outcome = respond(calls.length);
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: toBytes(init?.body),
    });
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }) as typeof fetch;
  return { calls, fn };
}

const OPTS = { ttlSeconds: 21600, topic: "digest-discounts", urgency: "normal" } as const;
const PAYLOAD = JSON.stringify({ title: "t", body: "b", url: "/", tag: "digest-discounts" });

Deno.test("sendPush posts an encrypted aes128gcm message with vapid auth, TTL, Topic and Urgency", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const { calls, fn } = fakeFetch(() => new Response(null, { status: 201 }));
  const result = await sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fn });
  assertEquals(result, { ok: true });
  assertEquals(calls.length, 1);
  const call = calls[0];
  assert(call);
  assertEquals(call.url, sub.endpoint);
  assertStringIncludes(call.headers.get("authorization") ?? "", "vapid t=");
  assertStringIncludes(call.headers.get("authorization") ?? "", `k=${env.publicKey}`);
  assertEquals(call.headers.get("content-encoding"), "aes128gcm");
  assertEquals(call.headers.get("ttl"), "21600");
  assertEquals(call.headers.get("topic"), "digest-discounts");
  assertEquals(call.headers.get("urgency"), "normal");
  assert(call.body.length > 16 + 4 + 1 + 65 + 16, "encrypted body carries header, key id and tag");
});

Deno.test("status mapping: 404 and 410 are gone, 413 too large, 429 rate limited with Retry-After", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const run = (res: Response | Error) =>
    sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fakeFetch(() => res).fn });
  assertEquals(await run(new Response(null, { status: 404 })), {
    ok: false,
    kind: "gone",
    status: 404,
  });
  assertEquals(await run(new Response(null, { status: 410 })), {
    ok: false,
    kind: "gone",
    status: 410,
  });
  assertEquals(await run(new Response(null, { status: 413 })), {
    ok: false,
    kind: "payload_too_large",
    status: 413,
  });
  assertEquals(await run(new Response(null, { status: 429, headers: { "retry-after": "120" } })), {
    ok: false,
    kind: "rate_limited",
    status: 429,
    retryAfterSec: 120,
  });
  assertEquals(await run(new Response(null, { status: 429 })), {
    ok: false,
    kind: "rate_limited",
    status: 429,
  });
  assertEquals(await run(new Response(null, { status: 500 })), {
    ok: false,
    kind: "http",
    status: 500,
  });
  assertEquals(await run(new Response(null, { status: 400 })), {
    ok: false,
    kind: "http",
    status: 400,
  });
  assertEquals(await run(new TypeError("connection refused")), { ok: false, kind: "network" });
});

Deno.test("Retry-After accepts an HTTP date relative to the injected clock", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const now = Date.parse("2026-10-15T10:00:00Z");
  const res = new Response(null, {
    status: 429,
    headers: { "retry-after": "Thu, 15 Oct 2026 10:01:30 GMT" },
  });
  const result = await sendPush(sub, PAYLOAD, OPTS, {
    env,
    fetchImpl: fakeFetch(() => res).fn,
    nowMs: () => now,
  });
  assertEquals(result, { ok: false, kind: "rate_limited", status: 429, retryAfterSec: 90 });
});

Deno.test("the global fetch is restored after a send, also after a failure", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const original = globalThis.fetch;
  await sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fakeFetch(() => new TypeError("x")).fn });
  assertEquals(globalThis.fetch, original);
});

Deno.test("invalid topic or ttl is a programming error", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const deps = { env, fetchImpl: fakeFetch(() => new Response(null, { status: 201 })).fn };
  await assertRejects(
    () => sendPush(sub, PAYLOAD, { ...OPTS, topic: "digest:discounts" }, deps),
    RangeError,
  );
  await assertRejects(
    () => sendPush(sub, PAYLOAD, { ...OPTS, topic: "x".repeat(33) }, deps),
    RangeError,
  );
  await assertRejects(() => sendPush(sub, PAYLOAD, { ...OPTS, ttlSeconds: 0 }, deps), RangeError);
});

Deno.test("loadPushEnv names the missing variable but never a value, and rejects mismatched keys", async () => {
  const env = await makeEnv();
  const get = (map: Record<string, string>) => (name: string) => map[name];
  const error = assertThrows(() => loadPushEnv(get({ VAPID_PUBLIC_KEY: env.publicKey })), Error);
  assertStringIncludes(error.message, "VAPID_PRIVATE_KEY");
  assertEquals(error.message.includes(env.publicKey), false);
  assertThrows(
    () =>
      loadPushEnv(
        get({
          VAPID_PUBLIC_KEY: env.publicKey,
          VAPID_PRIVATE_KEY: env.privateKeyJwk,
          VAPID_SUBJECT: "ops@example.test",
        }),
      ),
    Error,
    "VAPID_SUBJECT",
  );
  const other = await makeEnv();
  const sub = await makeSubscription();
  await assertRejects(
    () =>
      sendPush(sub, PAYLOAD, OPTS, {
        env: { ...env, publicKey: other.publicKey },
        fetchImpl: fakeFetch(() => new Response(null, { status: 201 })).fn,
      }),
    Error,
    "does not match",
  );
});

Deno.test("isAllowedPushEndpoint: https push services only", () => {
  const yes = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ];
  const no = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evil.example/web.push.apple.com",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ];
  for (const url of yes) assert(isAllowedPushEndpoint(url), url);
  for (const url of no) assertEquals(isAllowedPushEndpoint(url), false, url);
  assert(isAllowedPushEndpoint("https://push.example.test/x", ["push.example.test"]));
});
