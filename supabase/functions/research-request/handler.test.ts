import { createAcceptedIpCounter } from "@adapters/rate-limit.ts";
import { DEFAULT_RESEARCH_SETTINGS } from "@adapters/research_types.ts";
import { assertEquals } from "@std/assert";
import { FakeStore } from "../worker-tick/handlers/testing/fake_store.ts";
import { type HandlerDeps, handle, type InFlight, type PolicyDb } from "./handler.ts";

const SEC = "11111111-1111-4111-8111-111111111111";
const SITE = "https://site.example";
const NOW = Date.UTC(2026, 9, 19, 12, 30, 0);
const HOUR = 3_600_000;

interface Opts {
  onList?: boolean;
  inFlight?: boolean | InFlight;
  lastCompleteAt?: string | null;
  lastFailedAt?: string | null;
  lastFailedError?: string | null;
  quota?: { available: boolean; next_reset_at: string | null };
  settings?: Partial<typeof DEFAULT_RESEARCH_SETTINGS>;
  counterDown?: boolean;
  noRun?: boolean;
}

function setup(o: Opts = {}) {
  const store = new FakeStore();
  if (!o.noRun) {
    store.scanRuns.push({ id: "run-1", scanDateLocal: "2026-10-19" });
    store.publishedRunId = "run-1";
  }
  const audits: Record<string, unknown>[] = [];
  const counters = new Map<string, number>();
  const counterDown = o.counterDown ?? false;
  const db: PolicyDb = {
    onList: async () => o.onList ?? true,
    inFlight: async () =>
      o.inFlight === true
        ? { started_at: new Date(NOW - 60_000).toISOString(), requested_by: "visitor" as const }
        : o.inFlight || null,
    lastCompleteAt: async () => o.lastCompleteAt ?? null,
    lastFailed: async () =>
      o.lastFailedAt ? { at: o.lastFailedAt, error: o.lastFailedError ?? null } : null,
    quotaStatus: async () => o.quota ?? { available: true, next_reset_at: null },
    audit: async (row) => {
      audits.push(row);
    },
  };
  const settings = { ...DEFAULT_RESEARCH_SETTINGS, ...o.settings };
  const counter = createAcceptedIpCounter({
    fn: "research-request",
    window: "hour",
    limit: settings.visitor_scans_per_hour_per_ip,
    salt: "salt-salt-salt-salt-salt-salt-12",
    read: async (k) => {
      if (counterDown) throw new Error("down");
      return counters.get(k) ?? 0;
    },
    incr: async (k) => {
      if (counterDown) throw new Error("down");
      counters.set(k, (counters.get(k) ?? 0) + 1);
      return counters.get(k) ?? 0;
    },
    now: () => NOW,
  });
  const deps: HandlerDeps = {
    store,
    db,
    settings: async () => settings,
    counter,
    now: () => new Date(NOW),
    siteOrigin: SITE,
    rateLimitSalt: "salt-salt-salt-salt-salt-salt-12",
  };
  return { store, deps, audits, counters };
}

const post = (body: unknown, ip = "1.1.1.1", method = "POST") =>
  new Request("https://f.example/research-request", {
    method,
    headers: { "content-type": "application/json", origin: SITE, "cf-connecting-ip": ip },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });

async function call(
  h: ReturnType<typeof setup>,
  body: unknown = { security_id: SEC },
  ip?: string,
) {
  const res = await handle(post(body, ip), h.deps);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

Deno.test("OPTIONS answers 204 with CORS for the site and 403 for another origin", async () => {
  const h = setup();
  const ok = await handle(
    new Request("https://f.example/x", { method: "OPTIONS", headers: { origin: SITE } }),
    h.deps,
  );
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), SITE);
  const bad = await handle(
    new Request("https://f.example/x", { method: "OPTIONS", headers: { origin: "https://evil" } }),
    h.deps,
  );
  assertEquals(bad.status, 403);
});

Deno.test("rejects non-POST and a body without a UUID", async () => {
  const h = setup();
  assertEquals((await handle(post(null, "1.1.1.1", "GET"), h.deps)).status, 405);
  const r = await call(h, { security_id: "nope" });
  assertEquals(r.status, 400);
  assertEquals(r.body, { ok: false, reason: "invalid_input" });
  assertEquals((await call(h, "garbage")).status, 400);
});

Deno.test("success creates the queued report and its job, audits, counts the IP and answers the report id", async () => {
  const h = setup();
  const r = await call(h);
  assertEquals(r.status, 200);
  assertEquals(r.body.ok, true);
  const report = [...h.store.reports.values()][0];
  assertEquals(report?.status, "queued");
  assertEquals(report?.trigger, "visitor");
  assertEquals(typeof r.body.report_id, "string");
  assertEquals(r.body.report_id, report?.id);
  assertEquals(r.body.started_at, new Date(NOW).toISOString());
  assertEquals(r.res.headers.get("access-control-allow-origin"), SITE);
  assertEquals(h.store.jobs.length, 1);
  assertEquals(h.store.jobs[0]?.stage, "research");
  assertEquals(h.store.jobs[0]?.scanRunId, "run-1");
  assertEquals(h.audits.length, 1);
  const a = h.audits[0] as Record<string, unknown>;
  assertEquals(a.actor_id, null);
  assertEquals(a.action, "research_request");
  assertEquals(a.target_type, "security");
  assertEquals(a.target_id, SEC);
  const d = a.details as Record<string, unknown>;
  assertEquals(d.source, "visitor");
  assertEquals(d.report_id, report?.id);
  assertEquals(typeof d.ip_hash, "string");
  assertEquals(JSON.stringify(a).includes("1.1.1.1"), false);
  assertEquals([...h.counters.values()], [1]);
  assertEquals(await h.store.quotaUsed("visitor", "scans", "day"), 1);
});

Deno.test("not_on_list: no published run, or the security is not on its list (404)", async () => {
  const a = await call(setup({ onList: false }));
  assertEquals([a.status, a.body], [404, { ok: false, reason: "not_on_list" }]);
  const b = setup({ noRun: true });
  const r = await call(b);
  assertEquals([r.status, r.body.reason], [404, "not_on_list"]);
  assertEquals(b.store.jobs.length, 0);
});

Deno.test("in_flight (409) when a report or a research job of the security is open", async () => {
  const h = setup({ inFlight: true });
  const r = await call(h);
  assertEquals(
    [r.status, r.body],
    [
      409,
      {
        ok: false,
        reason: "in_flight",
        started_at: new Date(NOW - 60_000).toISOString(),
        requested_by: "visitor",
      },
    ],
  );
  assertEquals(h.store.jobs.length, 0);
  assertEquals(h.counters.size, 0);
});

Deno.test("in_flight (409) carries the start and requester of whoever asked first, as the feed maps them", async () => {
  const unknown = await call(setup({ inFlight: { started_at: null, requested_by: null } }));
  assertEquals(unknown.body, {
    ok: false,
    reason: "in_flight",
    started_at: null,
    requested_by: null,
  });
  const owner = setup({
    inFlight: { started_at: "2026-10-19T12:00:00.000Z", requested_by: "owner" },
  });
  assertEquals((await call(owner)).body.requested_by, "owner");
});

Deno.test("a lost race at the atomic accept answers 409 with the winner's start and creates nothing", async () => {
  const h = setup();
  const first = await call(h);
  assertEquals(first.status, 200);
  // the policy pre-check saw nothing in flight (db.inFlight is false), the accept step finds the first scan
  const second = await call(h, { security_id: SEC }, "2.2.2.2");
  assertEquals(second.status, 409);
  assertEquals(second.body, {
    ok: false,
    reason: "in_flight",
    started_at: new Date(NOW).toISOString(),
    requested_by: "visitor",
  });
  assertEquals(h.store.reports.size, 1);
  assertEquals(h.store.jobs.length, 1);
});

Deno.test("cooldown (429) with next_allowed_at after a recent complete report, none once it is older", async () => {
  const done = new Date(NOW - 10 * HOUR).toISOString();
  const h = setup({ lastCompleteAt: done });
  const r = await call(h);
  assertEquals(r.status, 429);
  assertEquals(r.body.reason, "cooldown");
  assertEquals(r.body.next_allowed_at, new Date(NOW - 10 * HOUR + 72 * HOUR).toISOString());
  assertEquals(h.store.jobs.length, 0);
  const old = setup({ lastCompleteAt: new Date(NOW - 73 * HOUR).toISOString() });
  assertEquals((await call(old)).status, 200);
});

Deno.test("retry_later (429) within visitor_retry_minutes of a failed report; failure never starts the cooldown", async () => {
  const failed = new Date(NOW - 20 * 60_000).toISOString();
  const h = setup({ lastFailedAt: failed });
  const r = await call(h);
  assertEquals(r.status, 429);
  assertEquals(r.body.reason, "retry_later");
  assertEquals(r.body.next_allowed_at, new Date(NOW + 40 * 60_000).toISOString());
  const later = setup({ lastFailedAt: new Date(NOW - 61 * 60_000).toISOString() });
  assertEquals((await call(later)).status, 200);
});

Deno.test("network_limit (429): three accepted requests per IP and hour; rejected ones do not count", async () => {
  const h = setup();
  const sec = (n: number) => `11111111-1111-4111-8111-11111111111${n}`;
  for (let i = 2; i < 5; i++) assertEquals((await call(h, { security_id: sec(i) })).status, 200);
  const r = await call(h);
  assertEquals(r.status, 429);
  assertEquals(r.body.reason, "network_limit");
  assertEquals(r.body.next_allowed_at, new Date(Date.UTC(2026, 9, 19, 13, 0, 0)).toISOString());
  assertEquals([...h.counters.values()], [3]);
  assertEquals(await h.store.quotaUsed("visitor", "scans", "day"), 3);
  assertEquals((await call(h, { security_id: SEC }, "2.2.2.2")).status, 200);
});

Deno.test("rejected requests never count toward the IP or the daily limits", async () => {
  const cases: Opts[] = [
    { onList: false },
    { inFlight: true },
    { lastCompleteAt: new Date(NOW).toISOString() },
    { lastFailedAt: new Date(NOW).toISOString() },
    { quota: { available: false, next_reset_at: null } },
  ];
  for (const o of cases) {
    const h = setup(o);
    await call(h);
    await call(h);
    assertEquals(h.counters.size, 0);
    assertEquals(await h.store.quotaUsed("visitor", "scans", "day"), 0);
  }
});

Deno.test("no_quota (429): the quota status says unavailable; next_allowed_at is its next reset", async () => {
  const reset = new Date(NOW + 5 * HOUR).toISOString();
  const h = setup({ quota: { available: false, next_reset_at: reset } });
  const r = await call(h);
  assertEquals(
    [r.status, r.body],
    [429, { ok: false, reason: "no_quota", next_allowed_at: reset }],
  );
  assertEquals(r.res.headers.get("retry-after"), String(5 * 3600));
  assertEquals(h.store.jobs.length, 0);
  assertEquals(h.counters.size, 0);
  const noDate = await call(setup({ quota: { available: false, next_reset_at: null } }));
  assertEquals([noDate.status, noDate.body], [429, { ok: false, reason: "no_quota" }]);
});

Deno.test("no_quota (429) when the visitor day slot is taken between the status read and the reservation", async () => {
  const day = setup({ settings: { visitor_scans_per_day: 1 } });
  assertEquals((await call(day)).status, 200);
  const second = await call(day, { security_id: SEC }, "9.9.9.9");
  assertEquals([second.status, second.body.reason], [429, "no_quota"]);
  assertEquals(day.store.jobs.length, 1);
});

Deno.test("a quota status read failure answers try_later (429)", async () => {
  const h = setup();
  h.deps.db.quotaStatus = async () => {
    throw new Error("rpc down");
  };
  const r = await call(h);
  assertEquals([r.status, r.body], [429, { ok: false, reason: "try_later" }]);
  assertEquals(h.store.jobs.length, 0);
});

Deno.test("providers_busy failure waits busy_retry_minutes (15), not visitor_retry_minutes", async () => {
  const failed = new Date(NOW - 10 * 60_000).toISOString();
  const h = setup({ lastFailedAt: failed, lastFailedError: "providers_busy" });
  const r = await call(h);
  assertEquals(r.status, 429);
  assertEquals(r.body.reason, "retry_later");
  assertEquals(r.body.next_allowed_at, new Date(NOW + 5 * 60_000).toISOString());
  const later = setup({
    lastFailedAt: new Date(NOW - 16 * 60_000).toISOString(),
    lastFailedError: "providers_busy",
  });
  assertEquals((await call(later)).status, 200);
  const custom = setup({
    lastFailedAt: new Date(NOW - 16 * 60_000).toISOString(),
    lastFailedError: "providers_busy",
    settings: { busy_retry_minutes: 30 } as never,
  });
  assertEquals((await call(custom)).body.reason, "retry_later");
});

Deno.test("a no_quota failure never blocks a new request once quota is available", async () => {
  const h = setup({
    lastFailedAt: new Date(NOW - 60_000).toISOString(),
    lastFailedError: "no_quota",
  });
  assertEquals((await call(h)).status, 200);
  const still = setup({
    lastFailedAt: new Date(NOW - 60_000).toISOString(),
    lastFailedError: "no_quota",
    quota: { available: false, next_reset_at: null },
  });
  assertEquals((await call(still)).body.reason, "no_quota");
});

Deno.test("checks run in the spec order", async () => {
  const all = setup({
    onList: false,
    inFlight: true,
    lastCompleteAt: new Date(NOW).toISOString(),
    quota: { available: false, next_reset_at: null },
  });
  assertEquals((await call(all)).body.reason, "not_on_list");
  const b = setup({
    inFlight: true,
    lastCompleteAt: new Date(NOW).toISOString(),
    quota: { available: false, next_reset_at: null },
  });
  assertEquals((await call(b)).body.reason, "in_flight");
  const c = setup({
    lastCompleteAt: new Date(NOW).toISOString(),
    lastFailedAt: new Date(NOW).toISOString(),
    quota: { available: false, next_reset_at: null },
  });
  assertEquals((await call(c)).body.reason, "cooldown");
  const d = setup({
    lastFailedAt: new Date(NOW).toISOString(),
    quota: { available: false, next_reset_at: null },
  });
  assertEquals((await call(d)).body.reason, "retry_later");
});

Deno.test("counter failure refuses with try_later (429) and spends nothing", async () => {
  const h = setup({ counterDown: true });
  const r = await call(h);
  assertEquals([r.status, r.body], [429, { ok: false, reason: "try_later" }]);
  assertEquals(h.store.jobs.length, 0);
  assertEquals(await h.store.quotaUsed("visitor", "scans", "day"), 0);
});

Deno.test("a failed audit write does not undo an accepted request", async () => {
  const h = setup();
  h.deps.db.audit = async () => {
    throw new Error("audit down");
  };
  const r = await call(h);
  assertEquals(r.status, 200);
  assertEquals(h.store.jobs.length, 1);
});

Deno.test("a store failure and a settings failure both answer try_later with 429", async () => {
  const store = setup();
  store.deps.store.latestPublishedRun = async () => {
    throw new Error("db down");
  };
  const a = await call(store);
  assertEquals([a.status, a.body], [429, { ok: false, reason: "try_later" }]);
  const cfg = setup();
  cfg.deps.settings = async () => {
    throw new Error("settings down");
  };
  const b = await call(cfg);
  assertEquals([b.status, b.body], [429, { ok: false, reason: "try_later" }]);
});
