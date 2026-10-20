import type { HoldingResult } from "@core/holding-tag.ts";
import type { FxRate, HeldPosition, QuoteInfo } from "@core/portfolio-view.ts";
import { assert, assertEquals } from "@std/assert";
import {
  handleRequest,
  type RefreshConnection,
  type RefreshDeps,
  type RefreshStore,
  type RevalueClaim,
} from "./handler.ts";
import type { QuoteSource } from "./quotes.ts";

const NOW = Date.UTC(2026, 9, 15, 7, 0, 0); // Thursday 10:00 Sofia: expected statement 2026-10-14
const USER = "a0000000-0000-4000-8000-00000000000a";

const position: HeldPosition = {
  id: 1,
  conid: 100001,
  symbol: "AAPL",
  description: "APPLE INC",
  assetClass: "STK",
  currency: "USD",
  quantity: 10,
  multiplier: 1,
  costBasisMoney: 2001.7,
  costBasisPrice: 200.17,
  markPrice: 230,
  fifoPnlUnrealized: 298.3,
  fxRateToBase: 0.92,
  reportDate: "2026-10-14",
  valuationSymbol: "AAPL",
  valuationTag: null,
  valuationSessionDate: null,
  valuationReason: null,
  matchStatus: "matched_isin",
};

function rig(
  o: {
    conn?: Partial<RefreshConnection> | null;
    positions?: HeldPosition[];
    quoteError?: boolean;
    activeRun?: boolean;
    runId?: string | null;
    claim?: Partial<RevalueClaim>;
    holding?: HoldingResult;
    rank?: number | null;
  } = {},
) {
  let lastManual: number | null = null;
  const state = {
    claims: 0,
    enqueued: [] as string[],
    statementTo: [] as string[],
    flexCalls: 0,
    positionLoads: 0,
    claimsRevalue: [] as Array<[string, number]>,
    applied: [] as Array<Record<string, unknown>>,
  };
  const conn: RefreshConnection | null =
    o.conn === null
      ? null
      : {
          status: "linked",
          base_currency: "EUR",
          last_statement_date: "2026-10-14",
          next_flex_fetch_not_before: null,
          last_manual_refresh_at: null,
          last_sync_at: null,
          coverage_from: null,
          ...o.conn,
        };
  const store: RefreshStore = {
    getConnection: () =>
      Promise.resolve(
        conn === null
          ? null
          : {
              ...conn,
              last_manual_refresh_at:
                lastManual === null ? null : new Date(lastManual).toISOString(),
            },
      ),
    // atomic by construction: the check and the write have no await between them, like the single SQL UPDATE ... WHERE
    claimManualRefresh: async () => {
      await Promise.resolve();
      state.claims += 1;
      if (lastManual === null || NOW - lastManual >= 60_000) {
        lastManual = NOW;
        return { claimed: true, availableAt: new Date(NOW + 60_000).toISOString() };
      }
      return { claimed: false, availableAt: new Date(lastManual + 60_000).toISOString() };
    },
    loadLatestPositions: () => {
      state.positionLoads += 1;
      return Promise.resolve(o.positions ?? [position]);
    },
    latestPublishedRunId: () => Promise.resolve(o.runId === undefined ? "run-1" : o.runId),
    claimHoldingRevalue: (user, conid) => {
      state.claimsRevalue.push([user, conid]);
      return Promise.resolve({
        outcome: "claimed",
        signalSecurityId: "sec-1",
        nextAllowedAt: new Date(NOW + 86_400_000).toISOString(),
        ...o.claim,
      });
    },
    loadRevalueInput: () =>
      Promise.resolve({ result: o.holding, worldwideRank: o.rank === undefined ? null : o.rank }),
    applyHoldingTag: (user, conid, t) => {
      state.applied.push({ user, conid, ...t });
      return Promise.resolve();
    },
    hasActiveRun: () => Promise.resolve(o.activeRun === true),
    enqueueDailySync: (_user, runDate, statementTo) => {
      state.statementTo.push(statementTo);
      state.enqueued.push(runDate);
      return Promise.resolve(true);
    },
  };
  const quotes: QuoteSource = {
    quotes: () =>
      Promise.resolve({
        map: new Map<string, QuoteInfo>(
          o.quoteError === true
            ? []
            : [
                [
                  "AAPL",
                  {
                    symbol: "AAPL",
                    price: 232,
                    currency: "USD",
                    changePercent: 1,
                    regularMarketTime: NOW - 60_000,
                    marketState: "REGULAR",
                    fetchedAtMs: NOW - 30_000,
                  },
                ],
              ],
        ),
        error: o.quoteError === true ? "quote_provider_unavailable" : null,
      }),
    fx: () =>
      Promise.resolve({
        map: new Map<string, FxRate>([
          ["USD>EUR", { rate: 0.93, rateDate: "2026-10-15", source: "yahoo" }],
        ]),
        error: null,
      }),
  };
  const deps: RefreshDeps = {
    verifier: { verify: (t) => Promise.resolve(t === "aaa.bbb.ccc" ? { userId: USER } : null) },
    store,
    quotes,
    nowMs: () => NOW,
    allowedOrigins: ["https://site.test"],
    log: () => undefined,
  };
  return { deps, state };
}

const req = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {
    authorization: "Bearer aaa.bbb.ccc",
    origin: "https://site.test",
  },
) =>
  new Request("https://x.test/functions/v1/portfolio-refresh", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

Deno.test("401 without a valid JWT, 405 for other methods, CORS preflight answered", async () => {
  const { deps } = rig();
  assertEquals((await handleRequest(req("GET", undefined, {}), deps)).status, 401);
  assertEquals(
    (await handleRequest(req("GET", undefined, { authorization: "Bearer bad.bad.bad" }), deps))
      .status,
    401,
  );
  assertEquals((await handleRequest(req("DELETE"), deps)).status, 405);
  const pre = await handleRequest(
    new Request("https://x.test/", { method: "OPTIONS", headers: { origin: "https://site.test" } }),
    deps,
  );
  assertEquals(
    [pre.status, pre.headers.get("access-control-allow-origin")],
    [204, "https://site.test"],
  );
});

Deno.test("409 not_linked without a usable connection", async () => {
  for (const conn of [null, { status: "unlinked" as const }, { status: "linking" as const }]) {
    const { deps } = rig({ conn });
    const res = await handleRequest(req("GET"), deps);
    assertEquals([res.status, (await res.json()).error], [409, "not_linked"]);
  }
});

Deno.test("GET: values the latest snapshot, carries server times, never claims the cooldown, never calls Flex", async () => {
  const { deps, state } = rig();
  const res = await handleRequest(req("GET"), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(state.claims, 0);
  assertEquals(state.flexCalls, 0);
  assertEquals(body.serverTime, new Date(NOW).toISOString());
  assertEquals(body.nextAutoRefreshAt, new Date(NOW + 300_000).toISOString());
  assertEquals(body.manualAvailableAt, new Date(NOW).toISOString());
  assertEquals(body.baseCurrency, "EUR");
  assertEquals(body.reportDate, "2026-10-14");
  assertEquals(body.statement, { expectedDate: "2026-10-14", freshness: { kind: "current" } });
  assertEquals(body.lastSuccessfulAt, new Date(NOW - 30_000).toISOString());
  assertEquals(body.view.positions[0].price.value, 232);
  assertEquals(body.view.positions[0].fxSource, "yahoo");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assert(!JSON.stringify(body).includes("flex_token"));
});

Deno.test("a statement that is behind enqueues the daily run once; an active run or the 6 hour back-off prevents it", async () => {
  const behind = rig({ conn: { last_statement_date: "2026-10-09" } });
  const body = await (await handleRequest(req("GET"), behind.deps)).json();
  assertEquals(
    [body.syncQueued, behind.state.enqueued, body.statement.freshness],
    [true, ["2026-10-15"], { kind: "behind", days: 5 }],
  );
  assertEquals(behind.state.statementTo, ["2026-10-14"]);

  const active = rig({ conn: { last_statement_date: "2026-10-09" }, activeRun: true });
  assertEquals((await (await handleRequest(req("GET"), active.deps)).json()).syncQueued, false);
  const backoff = rig({
    conn: {
      last_statement_date: "2026-10-09",
      next_flex_fetch_not_before: new Date(NOW + 3_600_000).toISOString(),
    },
  });
  assertEquals((await (await handleRequest(req("GET"), backoff.deps)).json()).syncQueued, false);
  assertEquals(backoff.state.enqueued, []);
});

Deno.test("POST manual: first call 200 with manualAvailableAt 60 s ahead, second call 429 with Retry-After", async () => {
  const { deps } = rig();
  const first = await handleRequest(req("POST", { manual: true }), deps);
  assertEquals(first.status, 200);
  assertEquals((await first.json()).manualAvailableAt, new Date(NOW + 60_000).toISOString());
  const second = await handleRequest(req("POST", { manual: true }), deps);
  assertEquals(second.status, 429);
  assertEquals(second.headers.get("retry-after"), "60");
  assertEquals(await second.json(), { error: "cooldown", retryAfterSeconds: 60 });
});

Deno.test("five parallel manual refreshes: exactly one passes, four get 429 (no check-then-act in the handler)", async () => {
  const { deps, state } = rig();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => handleRequest(req("POST", { manual: true }), deps)),
  );
  const statuses = results.map((r) => r.status).sort();
  assertEquals(statuses, [200, 429, 429, 429, 429]);
  assertEquals(state.claims, 5);
  assert(
    results.filter((r) => r.status === 429).every((r) => r.headers.get("retry-after") === "60"),
  );
});

Deno.test("a POST without manual:true behaves like an auto refresh", async () => {
  const { deps, state } = rig();
  assertEquals((await handleRequest(req("POST", {}), deps)).status, 200);
  assertEquals(state.claims, 0);
});

Deno.test("a quote failure still answers 200: statement closes are used, the error is reported, nothing is zero", async () => {
  const { deps } = rig({ quoteError: true });
  const res = await handleRequest(req("GET"), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.quoteError, "quote_provider_unavailable");
  assertEquals(body.lastSuccessfulAt, null);
  assertEquals(body.view.positions[0].price.source.kind, "statement_close");
  assertEquals(body.view.positions[0].marketValue.value, 2300);
});

Deno.test("a store failure is a 500 without details", async () => {
  const { deps } = rig();
  deps.store.loadLatestPositions = () => Promise.reject(new Error("db password=secret"));
  const res = await handleRequest(req("GET"), deps);
  const text = await res.text();
  assertEquals(res.status, 500);
  assertEquals(JSON.parse(text), { error: "internal_error" });
  assert(!text.includes("secret"));
});

Deno.test("only the newest report date is valued even if the store returns older rows", async () => {
  const { deps } = rig({ positions: [{ ...position, id: 7, reportDate: "2026-10-09" }, position] });
  const body = await (await handleRequest(req("GET"), deps)).json();
  assertEquals(
    body.view.positions.map((p: { id: number }) => p.id),
    [1],
  );
});

const END = { upper2: 140, upper1: 120, base: 100, lower1: 85, lower2: 70 };
const held = (o: Partial<HoldingResult> = {}): HoldingResult => ({
  securityId: "sec-1",
  status: "processed",
  sessionDate: "2026-10-14",
  close: 80,
  channel: { end: END },
  quoteType: "EQUITY",
  companyId: "co-1",
  ...o,
});
const revalue = (conid: unknown = 100001) => req("POST", { action: "revalue", conid });

Deno.test("revalue: recomputes the tag from the latest published run, stores it and reports the next allowed time", async () => {
  const { deps, state } = rig({ holding: held({ close: 80 }) });
  const res = await handleRequest(revalue(), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body, {
    ok: true,
    tag: "discounted",
    reason: "based on close of 2026-10-14",
    session_date: "2026-10-14",
    next_allowed_at: new Date(NOW + 86_400_000).toISOString(),
  });
  assertEquals(state.claimsRevalue, [[USER, 100001]]);
  assertEquals(state.applied, [
    {
      user: USER,
      conid: 100001,
      tag: "discounted",
      reason: "based on close of 2026-10-14",
      sessionDate: "2026-10-14",
    },
  ]);
  assertEquals(state.claims, 0); // the quote-refresh cooldown is untouched
  assertEquals(res.headers.get("cache-control"), "no-store");
});

Deno.test("revalue: a security without a scan result in the run becomes unavailable (still ok, still stamped)", async () => {
  const { deps } = rig({ holding: undefined });
  const body = await (await handleRequest(revalue(), deps)).json();
  assertEquals([body.ok, body.tag, body.session_date], [true, "unavailable", null]);
});

Deno.test("revalue: 404 not_found, 409 not_screened, 429 cooldown carry no tag write", async () => {
  const cases = [
    [{ outcome: "not_found", signalSecurityId: null, nextAllowedAt: null }, 404, "not_found"],
    [{ outcome: "not_screened", signalSecurityId: null, nextAllowedAt: null }, 409, "not_screened"],
    [
      { outcome: "cooldown", signalSecurityId: "sec-1", nextAllowedAt: "2026-10-16T07:00:00.000Z" },
      429,
      "cooldown",
    ],
  ] as const;
  for (const [claim, status, reason] of cases) {
    const { deps, state } = rig({ claim: { ...claim }, holding: held() });
    const res = await handleRequest(revalue(), deps);
    const body = await res.json();
    assertEquals([res.status, body.ok, body.reason], [status, false, reason]);
    assertEquals(state.applied.length, 0);
    if (reason === "cooldown") assertEquals(body.next_allowed_at, "2026-10-16T07:00:00.000Z");
  }
});

Deno.test("revalue: 409 no_scan before any published run, and the claim is not spent", async () => {
  const { deps, state } = rig({ runId: null });
  const res = await handleRequest(revalue(), deps);
  assertEquals([res.status, (await res.json()).reason], [409, "no_scan"]);
  assertEquals(state.claimsRevalue.length, 0);
});

Deno.test("revalue: 400 for a missing or non-integer conid; needs a JWT; works without a linked connection", async () => {
  const { deps, state } = rig({ conn: null, holding: held() });
  for (const conid of [undefined, "100001", 1.5, null, -1]) {
    const res = await handleRequest(req("POST", { action: "revalue", conid }), deps);
    assertEquals([res.status, (await res.json()).ok], [400, false]);
  }
  assertEquals(state.claimsRevalue.length, 0);
  assertEquals(
    (await handleRequest(req("POST", { action: "revalue", conid: 5 }, {}), deps)).status,
    401,
  );
  assertEquals((await handleRequest(revalue(), deps)).status, 200);
});

Deno.test("revalue: the worldwide rank of the run is passed to the tag mapping", async () => {
  const { deps } = rig({ holding: held({ close: 90 }), rank: 40 });
  assertEquals((await (await handleRequest(revalue(), deps)).json()).tag, "none");
});
