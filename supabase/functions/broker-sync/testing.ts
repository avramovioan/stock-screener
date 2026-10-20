import { open as realOpen, seal as realSeal, type Sealed, toBytea } from "@adapters/crypto.ts";
import type { FlexClient, SendResult, StatementResult } from "@adapters/flex.ts";
import { parseFlexStatement } from "@adapters/flex-parse.ts";
import type { IngestPayload } from "./persist.ts";
import {
  ACTIVE_STATES,
  type AuditEvent,
  type BrokerDeps,
  type ConnectionPatch,
  type ConnectionRow,
  type RunKind,
  type RunPatch,
  type RunRow,
  type SyncStore,
} from "./types.ts";

export const FIXTURE_XML = await Deno.readTextFile(
  new URL("../_shared/adapters/fixtures/flex/activity-sample.xml", import.meta.url),
);
export const USER = "a0000000-0000-4000-8000-00000000000a";
export const CONN = "c1000000-0000-4000-8000-00000000000a";
export const TOKEN = "987654321012345678901234";

export function randomKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

export class FakeClock {
  t = Date.UTC(2026, 9, 15, 5, 0, 0);
  sleeps: number[] = [];
  now = (): number => this.t;
  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  };
}

export class FakeStore implements SyncStore {
  conns = new Map<string, ConnectionRow>();
  runs = new Map<string, RunRow>();
  audits: AuditEvent[] = [];
  ingests: Array<{ runId: string; payload: IngestPayload }> = [];
  deleted: Array<{ userId: string; includeRuns: boolean }> = [];
  admins = new Set<string>();
  manual: { outcome: "created" | "busy" | "cooldown" | "not_linked"; retryAfterSeconds: number } = {
    outcome: "created",
    retryAfterSeconds: 0,
  };
  failIngest = false;
  private seq = 0;

  getConnection(userId: string) {
    return Promise.resolve([...this.conns.values()].find((c) => c.user_id === userId) ?? null);
  }
  getConnectionById(id: string) {
    return Promise.resolve(this.conns.get(id) ?? null);
  }
  upsertLinking(i: {
    id: string;
    userId: string;
    sealed: Sealed;
    queryId: string;
    tokenExpiresOn: string;
  }) {
    const old = this.conns.get(i.id);
    const row: ConnectionRow = {
      id: i.id,
      user_id: i.userId,
      status: "linking",
      flex_token_ciphertext: toBytea(i.sealed.ciphertext),
      flex_token_iv: toBytea(i.sealed.iv),
      key_version: i.sealed.version,
      token_expires_on: i.tokenExpiresOn,
      query_id: i.queryId,
      account_id_masked: old?.account_id_masked ?? null,
      base_currency: old?.base_currency ?? null,
      account_type: old?.account_type ?? null,
      linked_at: old?.linked_at ?? null,
      last_verified_at: old?.last_verified_at ?? null,
      last_sync_at: old?.last_sync_at ?? null,
      last_statement_date: old?.last_statement_date ?? null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      next_flex_fetch_not_before: null,
      coverage_from: old?.coverage_from ?? null,
    };
    this.conns.set(i.id, row);
    return Promise.resolve({ ...row });
  }
  patchConnection(id: string, patch: ConnectionPatch) {
    const c = this.conns.get(id);
    if (c !== undefined) this.conns.set(id, { ...c, ...patch });
    return Promise.resolve();
  }
  zeroToken(id: string) {
    const c = this.conns.get(id);
    if (c !== undefined) {
      this.conns.set(id, {
        ...c,
        status: "unlinked",
        flex_token_ciphertext: null,
        flex_token_iv: null,
        key_version: null,
        query_id: null,
        token_expires_on: null,
        linked_at: null,
      });
    }
    return Promise.resolve();
  }
  deleteBrokerData(userId: string, o: { includeRuns?: boolean } = {}) {
    this.deleted.push({ userId, includeRuns: o.includeRuns === true });
    return Promise.resolve();
  }
  cancelActiveRuns(userId: string, reason: string) {
    for (const r of this.runs.values()) {
      if (r.user_id === userId && ACTIVE_STATES.includes(r.state))
        this.runs.set(r.id, { ...r, state: "failed", error_code: -7, error_message: reason });
    }
    return Promise.resolve();
  }
  createRun(i: {
    userId: string;
    connectionId: string;
    kind: RunKind;
    statementFrom: string | null;
    statementTo: string | null;
    idempotencyKey: string;
  }) {
    const active = [...this.runs.values()].some(
      (r) => r.user_id === i.userId && ACTIVE_STATES.includes(r.state),
    );
    const dup = [...this.runs.values()].some((r) => r.idempotency_key === i.idempotencyKey);
    if (active || dup) return Promise.resolve(null);
    const run: RunRow = {
      id: `run-${++this.seq}`,
      user_id: i.userId,
      connection_id: i.connectionId,
      kind: i.kind,
      state: "queued",
      reference_code: null,
      requested_at: null,
      poll_count: 0,
      next_poll_at: null,
      statement_from: i.statementFrom,
      statement_to: i.statementTo,
      error_code: null,
      error_message: null,
      rows_summary: {},
      idempotency_key: i.idempotencyKey,
    };
    this.runs.set(run.id, run);
    return Promise.resolve({ ...run });
  }
  getRun(id: string) {
    return Promise.resolve(this.runs.get(id) ?? null);
  }
  latestActiveRun(userId: string) {
    return Promise.resolve(
      [...this.runs.values()].find(
        (r) => r.user_id === userId && ACTIVE_STATES.includes(r.state),
      ) ?? null,
    );
  }
  leased = new Set<string>();
  leaseRun(id: string) {
    const r = this.runs.get(id);
    if (r === undefined || !ACTIVE_STATES.includes(r.state) || this.leased.has(id))
      return Promise.resolve(null);
    this.leased.add(id);
    return Promise.resolve({ ...r });
  }
  claimRuns(limit: number) {
    const due = [...this.runs.values()].filter(
      (r) =>
        ACTIVE_STATES.includes(r.state) &&
        !this.leased.has(r.id) &&
        (r.next_poll_at === null || Date.parse(r.next_poll_at) <= this.clockNow()),
    );
    const take = due.slice(0, limit);
    for (const r of take) this.leased.add(r.id);
    return Promise.resolve(take.map((r) => ({ ...r })));
  }
  clockNow: () => number = () => Date.now();
  patchRun(id: string, patch: RunPatch) {
    const r = this.runs.get(id);
    if (r === undefined) throw new Error(`unknown run ${id}`);
    const { lease_until, last_poll_at: _b, finished_at: _c, ...rest } = patch;
    const next = { ...r, ...rest } as RunRow;
    if (lease_until === null) this.leased.delete(id);
    this.runs.set(id, next);
    return Promise.resolve({ ...next });
  }
  async enqueueManualSync(userId: string) {
    if (this.manual.outcome !== "created") return { runId: null, ...this.manual };
    const conn = [...this.conns.values()].find((c) => c.user_id === userId);
    const run =
      conn === undefined
        ? null
        : await this.createRun({
            userId,
            connectionId: conn.id,
            kind: "manual",
            statementFrom: null,
            statementTo: null,
            idempotencyKey: `${userId}:manual:${++this.seq}`,
          });
    return run === null
      ? { runId: null, outcome: "busy" as const, retryAfterSeconds: 0 }
      : { runId: run.id, outcome: "created" as const, retryAfterSeconds: 0 };
  }
  ingest(runId: string, payload: IngestPayload) {
    if (this.failIngest) return Promise.reject(new Error("db down"));
    this.ingests.push({ runId, payload });
    const conn = this.conns.get(this.runs.get(runId)?.connection_id ?? "");
    if (conn !== undefined) {
      this.conns.set(conn.id, {
        ...conn,
        account_id_masked: payload.meta.account_id_masked,
        base_currency: payload.meta.base_currency,
        account_type: payload.meta.account_type,
        last_statement_date: payload.meta.statement_to,
        last_sync_at: new Date(this.clockNow()).toISOString(),
      });
    }
    return Promise.resolve({
      positions: payload.positions.length,
      trades: payload.trades.length,
      closed_lots: payload.closed_lots.length,
      cash: payload.cash.length,
      fx: payload.fx.length,
      nav: payload.nav.length,
      corporate_actions: payload.corporate_actions.length,
    });
  }
  listConnectionsForRekey(current: number) {
    return Promise.resolve(
      [...this.conns.values()].filter(
        (c) =>
          c.key_version !== null && c.key_version !== current && c.flex_token_ciphertext !== null,
      ),
    );
  }
  rekeyConnection(id: string, sealed: Sealed) {
    const c = this.conns.get(id);
    if (c !== undefined)
      this.conns.set(id, {
        ...c,
        flex_token_ciphertext: toBytea(sealed.ciphertext),
        flex_token_iv: toBytea(sealed.iv),
        key_version: sealed.version,
      });
    return Promise.resolve();
  }
  isAdmin(userId: string) {
    return Promise.resolve(this.admins.has(userId));
  }
  audit(event: AuditEvent) {
    this.audits.push(event);
    return Promise.resolve();
  }
}

export class FakeFlex implements FlexClient {
  calls: Array<{ kind: "send" | "get"; token: string; arg: string; period?: unknown }> = [];
  constructor(
    public sends: SendResult[] = [],
    public gets: StatementResult[] = [],
  ) {}
  sendRequest(token: string, queryId: string, period?: unknown) {
    this.calls.push({ kind: "send", token, arg: queryId, period });
    return Promise.resolve(
      this.sends.shift() ?? { ok: false as const, code: 0, message: "no scripted response" },
    );
  }
  getStatement(token: string, referenceCode: string) {
    this.calls.push({ kind: "get", token, arg: referenceCode });
    return Promise.resolve(
      this.gets.shift() ?? { ok: false as const, code: 0, message: "no scripted response" },
    );
  }
}

export const SEND_OK: SendResult = { ok: true, referenceCode: "1234567890", url: null };
export const STATEMENT_OK: StatementResult = { ok: true, xml: FIXTURE_XML };
export const flexFail = (code: number): { ok: false; code: number; message: string } => ({
  ok: false,
  code,
  message: `error ${code}`,
});

export interface Rig {
  deps: BrokerDeps;
  store: FakeStore;
  flex: FakeFlex;
  clock: FakeClock;
  env: Map<string, string>;
  logs: Array<{ event: string; data?: Record<string, unknown> }>;
  matched: string[];
  riskRefreshed: string[];
  riskPaused: string[];
  riskRemoved: string[];
}

/** A linked connection for USER whose token was sealed with key V1; `deps.keys` read the keys from `env` like the real function does. */
export async function makeRig(o: { linked?: boolean; flex?: FakeFlex } = {}): Promise<Rig> {
  const env = new Map<string, string>([
    ["FLEX_ENC_KEY_V1", randomKey()],
    ["FLEX_ENC_KEY_CURRENT", "1"],
  ]);
  const reader = { get: (name: string) => env.get(name) };
  const store = new FakeStore();
  const clock = new FakeClock();
  store.clockNow = clock.now;
  const flex = o.flex ?? new FakeFlex();
  const logs: Rig["logs"] = [];
  const rig: Rig = {
    deps: undefined as never,
    store,
    flex,
    clock,
    env,
    logs,
    matched: [],
    riskRefreshed: [],
    riskPaused: [],
    riskRemoved: [],
  };
  rig.deps = {
    store,
    flex,
    keys: {
      seal: (plain, ctx) => realSeal(plain, ctx, reader),
      open: (sealed, ctx) => realOpen(sealed, ctx, reader),
      currentVersion: () => Number(env.get("FLEX_ENC_KEY_CURRENT") ?? "1"),
    },
    parse: (xml) => parseFlexStatement(xml),
    matcher: {
      matchUserPositions: (u) => (
        rig.matched.push(u), Promise.resolve({ matched: 2, unmatched: 0, notEquity: 0 })
      ),
    },
    riskSet: {
      refresh: (u) => (rig.riskRefreshed.push(u), Promise.resolve({ monitored: 0 })),
      pause: (u) => (rig.riskPaused.push(u), Promise.resolve()),
      remove: (u) => (rig.riskRemoved.push(u), Promise.resolve()),
    },
    now: clock.now,
    sleep: clock.sleep,
    log: (event, data) => void logs.push({ event, ...(data === undefined ? {} : { data }) }),
  };
  if (o.linked !== false) {
    const sealed = await rig.deps.keys.seal(TOKEN, { userId: USER, connectionId: CONN });
    await store.upsertLinking({
      id: CONN,
      userId: USER,
      sealed,
      queryId: "123456",
      tokenExpiresOn: "2027-01-01",
    });
  }
  return rig;
}

export async function newRun(
  rig: Rig,
  kind: RunKind = "verify",
  window: { from: string | null; to: string | null } = { from: null, to: null },
): Promise<RunRow> {
  const run = await rig.store.createRun({
    userId: USER,
    connectionId: CONN,
    kind,
    statementFrom: window.from,
    statementTo: window.to,
    idempotencyKey: `${USER}:${kind}:${rig.store.runs.size + 1}`,
  });
  if (run === null) throw new Error("run was not created");
  return run;
}
