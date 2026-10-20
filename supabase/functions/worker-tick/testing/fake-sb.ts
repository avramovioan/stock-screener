// biome-ignore-all lint/suspicious/noExplicitAny: an in-memory PostgREST double is untyped by nature
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * In-memory stand-in for the PostgREST client, enough for the stage handlers: select/insert/update/upsert/delete with the filters they use
 * (eq, neq, in, gt, gte, lt, lte, not-is-null), order, limit, range, single and head counts, plus `schema("app").rpc(name, args)` served by
 * registered functions. Unique constraints are enforced where a test registers them, so a handler bug that writes a duplicate fails like it
 * would against Postgres.
 */
export type Row = Record<string, any>;
export interface RpcResult {
  data?: unknown;
  error?: { message: string } | null;
}

export interface FakeSb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Unique constraints per table, e.g. { universe_snapshots: ["scan_run_id", "mode", "security_id"] }. */
  unique: Record<string, string[][]>;
  rpcs: Record<string, (args: Record<string, any>) => RpcResult>;
  rpcCalls: Array<{ name: string; args: Record<string, any> }>;
}

type Filter = (r: Row) => boolean;

/** Real tables whose primary key is not `id` (keep in step with the migrations). */
const NO_ID_COLUMN = new Set([
  "app_settings",
  "exchanges",
  "ibkr_catalogue",
  "notification_preferences",
  "price_series",
  "profiles",
  "quote_cache",
  "research_work_texts",
  "risk_monitor_state",
]);

export function createFakeSb(tables: Record<string, Row[]> = {}): FakeSb {
  const fake: FakeSb = { client: undefined as never, tables, unique: {}, rpcs: {}, rpcCalls: [] };
  let seq = 0;
  const table = (name: string): Row[] => {
    let t = fake.tables[name];
    if (t === undefined) {
      t = [];
      fake.tables[name] = t;
    }
    return t;
  };
  const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);

  class Query
    implements PromiseLike<{ data: any; error: { message: string } | null; count?: number | null }>
  {
    private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    private filters: Filter[] = [];
    private payload: Row[] = [];
    private patch: Row = {};
    private conflict: string[] = [];
    private ordering: Array<{ col: string; asc: boolean }> = [];
    private limitN: number | null = null;
    private from = 0;
    private to = Number.POSITIVE_INFINITY;
    private wantSingle = false;
    private wantCount = false;
    private head = false;
    private returning = false;
    constructor(private name: string) {}

    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (this.op !== "select") this.returning = true;
      if (opts?.count) this.wantCount = true;
      if (opts?.head) this.head = true;
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.payload = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
      return this;
    }
    upsert(rows: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
      this.op = "upsert";
      this.payload = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
      this.conflict = (o.onConflict ?? "id").split(",").map((c) => c.trim());
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(c: string, v: any) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: any) {
      this.filters.push((r) => r[c] !== v);
      return this;
    }
    in(c: string, v: any[]) {
      this.filters.push((r) => v.includes(r[c]));
      return this;
    }
    gt(c: string, v: any) {
      this.filters.push((r) => r[c] > v);
      return this;
    }
    gte(c: string, v: any) {
      this.filters.push((r) => r[c] >= v);
      return this;
    }
    lt(c: string, v: any) {
      this.filters.push((r) => r[c] < v);
      return this;
    }
    lte(c: string, v: any) {
      this.filters.push((r) => r[c] <= v);
      return this;
    }
    not(c: string, op: string, v: any) {
      if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v);
      else throw new Error(`fake-sb: not(${op}) is not supported`);
      return this;
    }
    order(col: string, o: { ascending?: boolean } = {}) {
      this.ordering.push({ col, asc: o.ascending !== false });
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    range(a: number, b: number) {
      this.from = a;
      this.to = b;
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }

    private violates(rows: Row[], candidate: Row, ignore?: Row): string | null {
      for (const cols of fake.unique[this.name] ?? []) {
        if (rows.some((r) => r !== ignore && cols.every((c) => r[c] === candidate[c])))
          return `duplicate key value violates unique constraint "${this.name}_${cols.join("_")}_key"`;
      }
      return null;
    }

    private run(): { data: any; error: { message: string } | null; count?: number | null } {
      const rows = table(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert" || this.op === "upsert") {
        const out: Row[] = [];
        for (const p of this.payload) {
          if (this.op === "upsert") {
            const existing = rows.find((r) => this.conflict.every((c) => r[c] === p[c]));
            if (existing !== undefined) {
              Object.assign(existing, p);
              out.push(existing);
              continue;
            }
          }
          if (
            p["id"] === undefined &&
            (this.name === "signal_episodes" || this.name === "scan_jobs")
          )
            p["id"] = this.name === "signal_episodes" ? `ep-${++seq}` : ++seq;
          if (p["id"] === undefined && this.name === "todays_discounts") p["id"] = ++seq;
          const err = this.violates(rows, p);
          if (err !== null) return { data: null, error: { message: err } };
          rows.push(p);
          out.push(p);
        }
        return {
          data: this.returning ? (this.wantSingle ? (out[0] ?? null) : out) : null,
          error: null,
        };
      }
      if (this.op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) {
          const next = { ...r, ...this.patch };
          const err = this.violates(rows, next, r);
          if (err !== null) return { data: null, error: { message: err } };
          Object.assign(r, this.patch);
        }
        return { data: this.returning ? hit : null, error: null };
      }
      if (this.op === "delete") {
        const keep = rows.filter((r) => !match(r));
        rows.length = 0;
        rows.push(...keep);
        return { data: null, error: null };
      }
      let hit = rows.filter(match);
      // Postgres rejects ordering by a column the table does not have; a fake that sorts on undefined hid exactly that bug once.
      if (this.ordering.some((o) => o.col === "id") && NO_ID_COLUMN.has(this.name))
        return { data: null, error: { message: `column ${this.name}.id does not exist` } };
      for (const o of [...this.ordering].reverse())
        hit = [...hit].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
      const count = hit.length;
      hit = hit.slice(this.from, Number.isFinite(this.to) ? this.to + 1 : undefined);
      if (this.limitN !== null) hit = hit.slice(0, this.limitN);
      const data = this.head
        ? null
        : this.wantSingle
          ? (hit[0] ?? null)
          : hit.map((r) => ({ ...r }));
      return {
        data,
        error: this.wantSingle && hit.length === 0 ? { message: "no rows" } : null,
        count: this.wantCount ? count : null,
      };
    }

    // biome-ignore lint/suspicious/noThenProperty: PostgREST builders are awaitable
    then<R1 = any, R2 = never>(
      ok?: ((v: any) => R1 | PromiseLike<R1>) | null,
      bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve()
        .then(() => this.run())
        .then(ok, bad);
    }
  }

  const client = {
    from: (name: string) => new Query(name),
    schema: (_s: string) => ({
      rpc: (name: string, args: Record<string, any>) => {
        fake.rpcCalls.push({ name, args });
        const fn = fake.rpcs[name];
        if (fn === undefined)
          return Promise.resolve({
            data: null,
            error: { message: `fake-sb: rpc ${name} is not registered` },
          });
        const r = fn(args);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      },
    }),
  };
  fake.client = client as unknown as SupabaseClient;
  return fake;
}

/** Mirror of app.transition_episode (migration 20261015001600) over the fake tables. */
export function registerTransitionEpisode(fake: FakeSb): void {
  fake.rpcs["transition_episode"] = (a) => {
    const eps = fake.tables["signal_episodes"] ?? [];
    const r = eps.find((e) => e["id"] === a["p_close_id"]);
    if (r === undefined) return { error: { message: "episode_not_found" } };
    const open = a["p_open"] as Row | null;
    if (r["status"] === "closed") {
      if (r["closed_session_date"] !== a["p_session_day"])
        return { error: { message: "episode_closed_for_another_session" } };
      if (open === null) return { data: r };
      const existing = eps.find((e) => e["continues_episode_id"] === a["p_close_id"]);
      if (existing !== undefined) return { data: existing };
    } else {
      Object.assign(r, {
        status: "closed",
        closed_scan_run_id: open?.["opened_scan_run_id"] ?? r["opened_scan_run_id"],
        closed_session_date: a["p_session_day"],
        close_reason: a["p_close_reason"],
        last_evaluated_session_date: a["p_session_day"],
      });
      if (open === null) return { data: r };
    }
    const row = {
      id: `ep-t${eps.length + 1}`,
      status: "active",
      ...open,
      continues_episode_id: a["p_close_id"],
      notify: open?.["notify"] ?? false,
    };
    eps.push(row);
    return { data: row };
  };
}
