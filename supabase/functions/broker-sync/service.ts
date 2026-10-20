// Actions of broker-sync (user mode and worker mode). Pure over BrokerDeps; the HTTP layer is handler.ts.

import { openToken, processStatement, runUntilSettled } from "./machine.ts";
import { type BrokerDeps, type ConnectionRow, publicConnection, publicRun } from "./types.ts";

export interface ServiceDeps extends BrokerDeps {
  /** keeps working after the response (EdgeRuntime.waitUntil); tests collect the promises */
  background(promise: Promise<unknown>): void;
  /** today's date in Europe/Sofia, "YYYY-MM-DD" */
  todayIso(): string;
  fixtureMode: boolean;
}

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const INLINE_BUDGET_MS = 60_000;
const BACKGROUND_BUDGET_MS = 120_000;

export interface LinkInput {
  token: string;
  queryId: string;
  tokenExpiresOn: string;
}

function dayNumberOf(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== Number(m[1]) ||
    back.getUTCMonth() !== Number(m[2]) - 1 ||
    back.getUTCDate() !== Number(m[3])
  )
    return null;
  return Math.floor(t / 86_400_000);
}

export function validateLinkInput(
  raw: unknown,
  todayIso: string,
): { ok: true; value: LinkInput } | { ok: false; field: string; message: string } {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const token = o["token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9._-]{8,200}$/.test(token))
    return { ok: false, field: "token", message: "Enter the token exactly as shown by IBKR." };
  const queryId = o["queryId"];
  if (typeof queryId !== "string" || !/^\d{3,12}$/.test(queryId))
    return { ok: false, field: "queryId", message: "The Query ID is a number of 3 to 12 digits." };
  const expires = o["tokenExpiresOn"];
  const e = typeof expires === "string" ? dayNumberOf(expires) : null;
  const today = dayNumberOf(todayIso);
  if (e === null || today === null)
    return { ok: false, field: "tokenExpiresOn", message: "Enter the token expiry date." };
  if (e <= today)
    return {
      ok: false,
      field: "tokenExpiresOn",
      message: "The token expiry date must be in the future.",
    };
  if (e - today > 366)
    return { ok: false, field: "tokenExpiresOn", message: "IBKR tokens last at most one year." };
  return { ok: true, value: { token, queryId, tokenExpiresOn: expires as string } };
}

async function inlineVerify(d: ServiceDeps, conn: ConnectionRow): Promise<ServiceResult> {
  const run = await d.store.createRun({
    userId: conn.user_id,
    connectionId: conn.id,
    kind: "verify",
    statementFrom: null,
    statementTo: null,
    idempotencyKey: `${conn.user_id}:verify:${crypto.randomUUID()}`,
  });
  if (run === null) return { status: 409, body: { error: "run_in_progress" } };
  const settled = await runUntilSettled(d, run.id, INLINE_BUDGET_MS);
  const fresh = await d.store.getConnection(conn.user_id);
  return {
    status: 200,
    body: {
      ok: true,
      run: settled === null ? null : publicRun(settled),
      connection: fresh === null ? null : publicConnection(fresh),
    },
  };
}

export async function link(d: ServiceDeps, userId: string, raw: unknown): Promise<ServiceResult> {
  const v = validateLinkInput(raw, d.todayIso());
  if (!v.ok)
    return { status: 400, body: { error: "invalid_input", field: v.field, message: v.message } };
  const active = await d.store.latestActiveRun(userId);
  if (active !== null)
    return { status: 409, body: { error: "run_in_progress", run: publicRun(active) } };

  const existing = await d.store.getConnection(userId);
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = await d.keys.seal(v.value.token, { userId, connectionId: id });
  const conn = await d.store.upsertLinking({
    id,
    userId,
    sealed,
    queryId: v.value.queryId,
    tokenExpiresOn: v.value.tokenExpiresOn,
  });
  await d.store.audit({
    actorUserId: userId,
    actor: "user",
    eventType: "broker.link",
    data: { connection: conn.id, kv: sealed.version },
  });
  d.log("link", { connection: conn.id });
  return await inlineVerify(d, conn);
}

export async function testConnection(d: ServiceDeps, userId: string): Promise<ServiceResult> {
  const conn = await d.store.getConnection(userId);
  if (conn === null || conn.flex_token_ciphertext === null || conn.status === "unlinked")
    return { status: 409, body: { error: "not_linked" } };
  const active = await d.store.latestActiveRun(userId);
  if (active !== null)
    return { status: 409, body: { error: "run_in_progress", run: publicRun(active) } };
  return await inlineVerify(d, conn);
}

export async function syncNow(d: ServiceDeps, userId: string): Promise<ServiceResult> {
  const r = await d.store.enqueueManualSync(userId);
  if (r.outcome === "created" && r.runId !== null) {
    const runId = r.runId;
    d.background(
      runUntilSettled(d, runId, BACKGROUND_BUDGET_MS).catch((e: unknown) =>
        d.log("sync_background_failed", {
          run: runId,
          error: e instanceof Error ? e.name : "error",
        }),
      ),
    );
    const run = await d.store.getRun(runId);
    return { status: 202, body: { ok: true, run: run === null ? { id: runId } : publicRun(run) } };
  }
  if (r.outcome === "cooldown") {
    return {
      status: 429,
      headers: { "retry-after": String(r.retryAfterSeconds) },
      body: { error: "cooldown", retryAfterSeconds: r.retryAfterSeconds },
    };
  }
  return { status: 409, body: { error: r.outcome === "busy" ? "run_in_progress" : "not_linked" } };
}

export async function unlink(d: ServiceDeps, userId: string, raw: unknown): Promise<ServiceResult> {
  const deleteData =
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>)["deleteData"] === true;
  const conn = await d.store.getConnection(userId);
  if (conn === null) return { status: 200, body: { ok: true, connection: null } };
  await d.store.cancelActiveRuns(userId, "The broker was unlinked.");
  await d.store.zeroToken(conn.id);
  await d.riskSet.pause(userId);
  if (deleteData) {
    await d.store.deleteBrokerData(userId, { includeRuns: true });
    await d.riskSet.remove(userId);
  }
  await d.store.audit({
    actorUserId: userId,
    actor: "user",
    eventType: "broker.unlink",
    data: { delete_data: deleteData },
  });
  const fresh = await d.store.getConnection(userId);
  return {
    status: 200,
    body: { ok: true, connection: fresh === null ? null : publicConnection(fresh) },
  };
}

/** Admin: decrypt with the stored key version, encrypt with the current one (spec 6.7). Safe to repeat. */
export async function rekeyAll(d: ServiceDeps, actorUserId: string | null): Promise<ServiceResult> {
  const current = d.keys.currentVersion();
  let rekeyed = 0;
  let failed = 0;
  for (const conn of await d.store.listConnectionsForRekey(current)) {
    try {
      const plain = await openToken(d, conn);
      await d.store.rekeyConnection(
        conn.id,
        await d.keys.seal(plain, { userId: conn.user_id, connectionId: conn.id }),
      );
      rekeyed += 1;
    } catch {
      failed += 1;
    }
  }
  await d.store.audit({
    actorUserId,
    actor: actorUserId === null ? "service" : "admin",
    eventType: "broker.token_rekey",
    data: { rekeyed, failed, to: current },
  });
  return { status: 200, body: { ok: true, rekeyed, failed } };
}

/** Integration tests only (P5b-D13): loads a statement through exactly the path of a real one, without calling IBKR. */
export async function ingestFixture(d: ServiceDeps, raw: unknown): Promise<ServiceResult> {
  if (!d.fixtureMode) return { status: 403, body: { error: "fixture_mode_disabled" } };
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof o["userId"] !== "string" || typeof o["xml"] !== "string" || o["xml"] === "")
    return { status: 400, body: { error: "invalid_input" } };
  const conn = await d.store.getConnection(o["userId"]);
  if (conn === null) return { status: 404, body: { error: "not_linked" } };
  const run = await d.store.createRun({
    userId: conn.user_id,
    connectionId: conn.id,
    kind: "daily",
    statementFrom: null,
    statementTo: null,
    idempotencyKey: `${conn.user_id}:fixture:${crypto.randomUUID()}`,
  });
  if (run === null) return { status: 409, body: { error: "run_in_progress" } };
  const done = await processStatement(d, run, conn, o["xml"]);
  return { status: 200, body: { ok: true, run: publicRun(done) } };
}
