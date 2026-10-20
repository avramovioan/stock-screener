import { assert, assertEquals } from "@std/assert";
import {
  ingestFixture,
  link,
  rekeyAll,
  syncNow,
  testConnection,
  unlink,
  validateLinkInput,
} from "./service.ts";
import {
  CONN,
  FakeFlex,
  FIXTURE_XML,
  flexFail,
  makeRig,
  randomKey,
  SEND_OK,
  STATEMENT_OK,
  TOKEN,
  USER,
} from "./testing.ts";

const TODAY = "2026-10-15";
const input = (o: Record<string, unknown> = {}) => ({
  token: TOKEN,
  queryId: "123456",
  tokenExpiresOn: "2027-06-01",
  ...o,
});

function svc(rig: Awaited<ReturnType<typeof makeRig>>, o: { fixtureMode?: boolean } = {}) {
  const background: Array<Promise<unknown>> = [];
  return {
    background,
    deps: {
      ...rig.deps,
      background: (p: Promise<unknown>) => void background.push(p),
      todayIso: () => TODAY,
      fixtureMode: o.fixtureMode ?? false,
    },
  };
}

Deno.test("validateLinkInput: token charset and length, numeric query id, expiry in the future and at most one year", () => {
  assertEquals(validateLinkInput(input(), TODAY).ok, true);
  for (const [field, bad] of [
    ["token", ""],
    ["token", "short"],
    ["token", "has space in it 123"],
    ["token", "x".repeat(300)],
    ["queryId", "abc"],
    ["queryId", "12"],
    ["queryId", "1234567890123"],
    ["tokenExpiresOn", "2026-10-15"],
    ["tokenExpiresOn", "2026-10-14"],
    ["tokenExpiresOn", "2027-10-17"],
    ["tokenExpiresOn", "not a date"],
    ["tokenExpiresOn", "2027-02-30"],
  ] as const) {
    const r = validateLinkInput(input({ [field]: bad }), TODAY);
    assertEquals(r.ok === false && r.field, field, `${field}=${bad}`);
  }
  assertEquals(validateLinkInput(input({ tokenExpiresOn: "2027-10-16" }), TODAY).ok, true);
  assertEquals(validateLinkInput(null, TODAY).ok, false);
});

Deno.test("link stores the token sealed, never returns it, verifies inline and ends linked", async () => {
  const rig = await makeRig({ linked: false, flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const { deps } = svc(rig);
  const out = await link(deps, USER, input());
  assertEquals(out.status, 200);
  const text = JSON.stringify(out.body);
  assert(!text.includes(TOKEN));
  assert(
    !text.includes("ciphertext") && !text.includes("flex_token") && !text.includes("key_version"),
  );
  const body = out.body as {
    run: { state: string };
    connection: { status: string; account_id_masked: string };
  };
  assertEquals(
    [body.run.state, body.connection.status, body.connection.account_id_masked],
    ["done", "linked", "U***4567"],
  );
  const stored = [...rig.store.conns.values()][0];
  const plainHex = Array.from(new TextEncoder().encode(TOKEN), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  assert(stored?.flex_token_ciphertext !== null && stored?.flex_token_ciphertext !== undefined);
  assert(!stored.flex_token_ciphertext.includes(plainHex));
  assertEquals(stored.key_version, 1);
  assert(rig.store.audits.some((a) => a.eventType === "broker.link"));
  assert(!JSON.stringify(rig.store.audits).includes(TOKEN));
  assertEquals(rig.flex.calls[0]?.token, TOKEN);
});

Deno.test("link rejects bad input with the offending field and a run that is already active with 409", async () => {
  const rig = await makeRig({ linked: false });
  const { deps } = svc(rig);
  const bad = await link(deps, USER, input({ queryId: "x" }));
  assertEquals([bad.status, (bad.body as { field: string }).field], [400, "queryId"]);
  assertEquals(rig.flex.calls.length, 0);

  const busy = await makeRig({ flex: new FakeFlex([SEND_OK]) });
  await busy.store.createRun({
    userId: USER,
    connectionId: CONN,
    kind: "daily",
    statementFrom: null,
    statementTo: null,
    idempotencyKey: "x",
  });
  const out = await link(svc(busy).deps, USER, input());
  assertEquals(out.status, 409);
  assertEquals((out.body as { error: string }).error, "run_in_progress");
});

Deno.test("link with a token IBKR rejects ends in error with the mapped message", async () => {
  const rig = await makeRig({ linked: false, flex: new FakeFlex([flexFail(1015)]) });
  const out = await link(svc(rig).deps, USER, input());
  const body = out.body as {
    run: { state: string; error_code: number };
    connection: { status: string; last_error_code: number };
  };
  assertEquals(
    [
      out.status,
      body.run.state,
      body.run.error_code,
      body.connection.status,
      body.connection.last_error_code,
    ],
    [200, "failed", 1015, "error", 1015],
  );
});

Deno.test("test connection needs a stored token and runs a verify inline", async () => {
  const none = await makeRig({ linked: false });
  assertEquals((await testConnection(svc(none).deps, USER)).status, 409);
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const out = await testConnection(svc(rig).deps, USER);
  assertEquals(
    [
      out.status,
      (out.body as { run: { kind: string; state: string } }).run.kind,
      (out.body as { run: { state: string } }).run.state,
    ],
    [200, "verify", "done"],
  );
});

Deno.test("sync: created runs in the background, busy 409, cooldown 429 with Retry-After, not linked 409", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const s = svc(rig);
  const created = await syncNow(s.deps, USER);
  assertEquals(created.status, 202);
  assertEquals(s.background.length, 1);
  await Promise.all(s.background);
  assertEquals(
    [...rig.store.runs.values()].map((r) => [r.kind, r.state]),
    [["manual", "done"]],
  );

  for (const [outcome, status] of [
    ["busy", 409],
    ["not_linked", 409],
  ] as const) {
    rig.store.manual = { outcome, retryAfterSeconds: 0 };
    assertEquals((await syncNow(s.deps, USER)).status, status);
  }
  rig.store.manual = { outcome: "cooldown", retryAfterSeconds: 321 };
  const cool = await syncNow(s.deps, USER);
  assertEquals(
    [
      cool.status,
      cool.headers?.["retry-after"],
      (cool.body as { retryAfterSeconds: number }).retryAfterSeconds,
    ],
    [429, "321", 321],
  );
});

Deno.test("unlink zeroes the ciphertext, IV, key version and query id, cancels runs, pauses monitoring and audits", async () => {
  const rig = await makeRig();
  await rig.store.createRun({
    userId: USER,
    connectionId: CONN,
    kind: "daily",
    statementFrom: null,
    statementTo: null,
    idempotencyKey: "d",
  });
  const out = await unlink(svc(rig).deps, USER, { deleteData: false });
  assertEquals(out.status, 200);
  const c = rig.store.conns.get(CONN);
  assertEquals(
    [
      c?.status,
      c?.flex_token_ciphertext,
      c?.flex_token_iv,
      c?.key_version,
      c?.query_id,
      c?.token_expires_on,
    ],
    ["unlinked", null, null, null, null, null],
  );
  assertEquals(
    [...rig.store.runs.values()].every((r) => r.state === "failed"),
    true,
  );
  assertEquals(rig.riskPaused, [USER]);
  assertEquals(rig.store.deleted, []);
  assert(
    rig.store.audits.some(
      (a) => a.eventType === "broker.unlink" && a.data["delete_data"] === false,
    ),
  );
  assert(!JSON.stringify(out.body).includes("ciphertext"));
});

Deno.test("unlink with deleteData also removes the synced rows and the monitoring state; unlinking twice is a no-op", async () => {
  const rig = await makeRig();
  const d = svc(rig).deps;
  await unlink(d, USER, { deleteData: true });
  assertEquals(rig.store.deleted, [{ userId: USER, includeRuns: true }]);
  assertEquals(rig.riskRemoved, [USER]);
  assertEquals((await unlink(d, USER, { deleteData: false })).status, 200);
  assertEquals((await unlink(svc(await makeRig({ linked: false })).deps, USER, {})).status, 200);
});

Deno.test("rekey re-encrypts under the current key, a second rekey is a no-op, an unreadable row is counted as failed", async () => {
  const rig = await makeRig();
  const v2 = randomKey();
  rig.env.set("FLEX_ENC_KEY_V2", v2);
  rig.env.set("FLEX_ENC_KEY_CURRENT", "2");
  const d = svc(rig).deps;
  const first = await rekeyAll(d, "admin-1");
  assertEquals(first.body, { ok: true, rekeyed: 1, failed: 0 });
  assertEquals(rig.store.conns.get(CONN)?.key_version, 2);
  rig.env.delete("FLEX_ENC_KEY_V1");
  assertEquals((await rekeyAll(d, null)).body, { ok: true, rekeyed: 0, failed: 0 });

  const broken = await makeRig();
  broken.env.delete("FLEX_ENC_KEY_V1");
  broken.env.set("FLEX_ENC_KEY_V2", v2);
  broken.env.set("FLEX_ENC_KEY_CURRENT", "2");
  assertEquals((await rekeyAll(svc(broken).deps, null)).body, { ok: true, rekeyed: 0, failed: 1 });
  assert(
    broken.store.audits.some((a) => a.eventType === "broker.token_rekey" && a.data["failed"] === 1),
  );
});

Deno.test("ingest_fixture is refused unless fixture mode is on, and otherwise loads the XML through the same path as a real statement", async () => {
  const rig = await makeRig();
  const off = await ingestFixture(svc(rig, { fixtureMode: false }).deps, {
    userId: USER,
    xml: FIXTURE_XML,
  });
  assertEquals(off.status, 403);
  assertEquals(rig.store.ingests.length, 0);
  const on = await ingestFixture(svc(rig, { fixtureMode: true }).deps, {
    userId: USER,
    xml: FIXTURE_XML,
  });
  assertEquals(on.status, 200);
  assertEquals(rig.store.ingests.length, 1);
  assertEquals(
    (await ingestFixture(svc(rig, { fixtureMode: true }).deps, { userId: 5, xml: "" })).status,
    400,
  );
});
