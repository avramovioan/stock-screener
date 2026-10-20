import { assert, assertEquals } from "@std/assert";
import { type HandlerDeps, handleRequest, isLocalUrl } from "./handler.ts";
import { FakeFlex, flexFail, makeRig, SEND_OK, STATEMENT_OK, TOKEN, USER } from "./testing.ts";

const SECRET = "cron-secret";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x.test/functions/v1/broker-sync", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://site.test", ...headers },
    body: JSON.stringify(body),
  });
const jwt = { authorization: "Bearer aaa.bbb.ccc" };

async function setup(o: { flex?: FakeFlex; fixtureMode?: boolean; admin?: boolean } = {}) {
  const rig = await makeRig({ flex: o.flex ?? new FakeFlex() });
  if (o.admin === true) rig.store.admins.add(USER);
  const deps: HandlerDeps = {
    brokerDeps: {
      ...rig.deps,
      background: () => undefined,
      todayIso: () => "2026-10-15",
      fixtureMode: o.fixtureMode ?? false,
    },
    verifier: {
      verify: (token) => Promise.resolve(token === "aaa.bbb.ccc" ? { userId: USER } : null),
    },
    cronSecret: SECRET,
    allowedOrigins: ["https://site.test"],
  };
  return { rig, deps };
}

Deno.test("CORS preflight is answered, other methods are 405", async () => {
  const { deps } = await setup();
  const pre = await handleRequest(
    new Request("https://x.test/", { method: "OPTIONS", headers: { origin: "https://site.test" } }),
    deps,
  );
  assertEquals(
    [pre.status, pre.headers.get("access-control-allow-origin")],
    [204, "https://site.test"],
  );
  assertEquals(
    (await handleRequest(new Request("https://x.test/", { method: "GET" }), deps)).status,
    405,
  );
});

Deno.test("user mode needs a valid JWT; the cron header needs the right secret", async () => {
  const { deps } = await setup();
  assertEquals((await handleRequest(post({ action: "test" }), deps)).status, 401);
  assertEquals(
    (await handleRequest(post({ action: "test" }, { authorization: "Bearer bad.bad.bad" }), deps))
      .status,
    401,
  );
  assertEquals(
    (await handleRequest(post({ action: "tick" }, { "x-cron-secret": "wrong" }), deps)).status,
    401,
  );
  assertEquals((await handleRequest(post({ action: "tick" }), deps)).status, 401);
});

Deno.test("worker actions are not available to users, user actions are not available to the worker", async () => {
  const { deps } = await setup();
  assertEquals((await handleRequest(post({ action: "tick" }, jwt), deps)).status, 403);
  assertEquals(
    (await handleRequest(post({ action: "ingest_fixture", userId: USER, xml: "x" }, jwt), deps))
      .status,
    403,
  );
  assertEquals(
    (await handleRequest(post({ action: "link" }, { "x-cron-secret": SECRET }), deps)).status,
    400,
  );
  assertEquals((await handleRequest(post({ action: "nonsense" }, jwt), deps)).status, 400);
  assertEquals((await handleRequest(post({}, jwt), deps)).status, 400);
});

Deno.test("link over HTTP: 400 for bad input, 200 with a safe body and the token never in the response", async () => {
  const bad = await setup();
  const res400 = await handleRequest(
    post({ action: "link", token: TOKEN, queryId: "abc", tokenExpiresOn: "2027-06-01" }, jwt),
    bad.deps,
  );
  assertEquals(res400.status, 400);
  assertEquals((await res400.json()).field, "queryId");

  const { deps, rig } = await setup({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  await rig.store.zeroToken("c1000000-0000-4000-8000-00000000000a");
  const res = await handleRequest(
    post({ action: "link", token: TOKEN, queryId: "123456", tokenExpiresOn: "2027-06-01" }, jwt),
    deps,
  );
  const text = await res.text();
  assertEquals(res.status, 200);
  assert(!text.includes(TOKEN));
  assert(!/ciphertext|flex_token|key_version/.test(text));
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("access-control-allow-origin"), "https://site.test");
});

Deno.test("sync cooldown is a 429 with Retry-After", async () => {
  const { deps, rig } = await setup();
  rig.store.manual = { outcome: "cooldown", retryAfterSeconds: 400 };
  const res = await handleRequest(post({ action: "sync" }, jwt), deps);
  assertEquals([res.status, res.headers.get("retry-after")], [429, "400"]);
});

Deno.test("rekey is allowed for the cron secret and for admins only", async () => {
  const user = await setup();
  assertEquals((await handleRequest(post({ action: "rekey" }, jwt), user.deps)).status, 403);
  const admin = await setup({ admin: true });
  assertEquals((await handleRequest(post({ action: "rekey" }, jwt), admin.deps)).status, 200);
  assertEquals(
    (await handleRequest(post({ action: "rekey" }, { "x-cron-secret": SECRET }), user.deps)).status,
    200,
  );
});

Deno.test("tick answers 200 with the number of processed runs; an unexpected error is a 500 without details", async () => {
  const { deps, rig } = await setup({ flex: new FakeFlex([flexFail(1018)]) });
  await rig.store.createRun({
    userId: USER,
    connectionId: "c1000000-0000-4000-8000-00000000000a",
    kind: "daily",
    statementFrom: null,
    statementTo: null,
    idempotencyKey: "k",
  });
  const ok = await handleRequest(post({ action: "tick" }, { "x-cron-secret": SECRET }), deps);
  assertEquals([ok.status, (await ok.json()).processed], [200, 1]);
  rig.store.claimRuns = () => Promise.reject(new Error(`boom ${TOKEN}`));
  const boom = await handleRequest(post({ action: "tick" }, { "x-cron-secret": SECRET }), deps);
  assertEquals(boom.status, 500);
  const text = await boom.text();
  assertEquals(JSON.parse(text), { error: "internal_error" });
  assert(!text.includes(TOKEN));
});

Deno.test("ingest_fixture works in worker mode only with fixture mode on", async () => {
  const off = await setup();
  assertEquals(
    (
      await handleRequest(
        post({ action: "ingest_fixture", userId: USER, xml: "<x/>" }, { "x-cron-secret": SECRET }),
        off.deps,
      )
    ).status,
    403,
  );
  const on = await setup({ fixtureMode: true });
  assertEquals(
    (
      await handleRequest(
        post({ action: "ingest_fixture", userId: USER, xml: "<x/>" }, { "x-cron-secret": SECRET }),
        on.deps,
      )
    ).status,
    200,
  );
});

Deno.test("fixture mode is only ever enabled for a local Supabase URL", () => {
  for (const url of [
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://host.docker.internal:54321",
    "http://kong:8000", // SUPABASE_URL inside the local edge-runtime container
  ])
    assertEquals(isLocalUrl(url), true, url);
  for (const url of ["https://abc.supabase.co", "http://127.0.0.1.evil.com", "", "not a url"])
    assertEquals(isLocalUrl(url), false, url);
});
