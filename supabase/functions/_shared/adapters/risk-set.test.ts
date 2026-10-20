import { assertEquals } from "@std/assert";
import { createFakeSb } from "../../worker-tick/testing/fake-sb.ts";
import {
  createRiskSetStore,
  monitoredReasons,
  type RiskHolding,
  type RiskSetStore,
  refreshRiskSet,
} from "./risk-set.ts";

Deno.test("reasons: outside the top 50, not a universe member, below US$50B; operating companies only", () => {
  const base = { isOperatingCompany: true, worldwideRank: 12, marketCapUsd: 90e9 };
  assertEquals(monitoredReasons(base), []);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 50 }), []);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 51 }), ["outside_top50"]);
  assertEquals(monitoredReasons({ ...base, worldwideRank: null }), ["not_in_universe"]);
  assertEquals(monitoredReasons({ ...base, marketCapUsd: 49.999e9 }), ["below_50b"]);
  assertEquals(monitoredReasons({ ...base, marketCapUsd: 50e9 }), []);
  assertEquals(monitoredReasons({ ...base, worldwideRank: null, marketCapUsd: 3e9 }), [
    "not_in_universe",
    "below_50b",
  ]);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 70, marketCapUsd: null }), [
    "outside_top50",
  ]);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 12, marketCapUsd: null }), []);
  assertEquals(
    monitoredReasons({ isOperatingCompany: false, worldwideRank: null, marketCapUsd: 1e9 }),
    [],
  );
});

function fakeStore(holdings: RiskHolding[]) {
  const synced: Array<{
    userId: string;
    active: Array<{ securityId: string; reasons: string[] }>;
  }> = [];
  const store: RiskSetStore = {
    holdings: (userId) =>
      Promise.resolve(
        userId === undefined ? holdings : holdings.filter((h) => h.userId === userId),
      ),
    syncState: (userId, active) => (synced.push({ userId, active }), Promise.resolve()),
    pause: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  return { store, synced };
}

Deno.test("refreshRiskSet writes active rows with reasons for monitored holdings and none for the rest", async () => {
  const { store, synced } = fakeStore([
    { userId: "u1", securityId: "s-big", isOperating: true, worldwideRank: 3, marketCapUsd: 3e12 },
    {
      userId: "u1",
      securityId: "s-small",
      isOperating: true,
      worldwideRank: null,
      marketCapUsd: 5e9,
    },
    {
      userId: "u1",
      securityId: "s-etf",
      isOperating: false,
      worldwideRank: null,
      marketCapUsd: null,
    },
    { userId: "u2", securityId: "s-mid", isOperating: true, worldwideRank: 80, marketCapUsd: 60e9 },
  ]);
  const out = await refreshRiskSet(store, "u1");
  assertEquals(out, { monitored: 1 });
  assertEquals(synced, [
    {
      userId: "u1",
      active: [{ securityId: "s-small", reasons: ["not_in_universe", "below_50b"] }],
    },
  ]);
});

Deno.test("without a user id every user with holdings is synchronised (stage 8 risk_set)", async () => {
  const { store, synced } = fakeStore([
    { userId: "u1", securityId: "a", isOperating: true, worldwideRank: 90, marketCapUsd: 70e9 },
    { userId: "u2", securityId: "b", isOperating: true, worldwideRank: 10, marketCapUsd: 70e9 },
  ]);
  assertEquals(await refreshRiskSet(store), { monitored: 1 });
  assertEquals(
    synced.map((s) => [s.userId, s.active.length]),
    [
      ["u1", 1],
      ["u2", 0],
    ],
  );
});

Deno.test("store: ranks come from the latest published run only, so a security that left the universe is monitored", async () => {
  const fake = createFakeSb({
    broker_connections: [{ user_id: "u1", status: "linked" }],
    securities: [{ id: "s1", quote_type: "EQUITY" }],
    scan_runs: [
      { id: "old", scan_date_local: "2026-10-01", list_published_at: "2026-10-01T10:00:00Z" },
      { id: "new", scan_date_local: "2026-10-14", list_published_at: "2026-10-14T10:00:00Z" },
      { id: "unpublished", scan_date_local: "2026-10-15", list_published_at: null },
    ],
    // top 50 in the old run, gone from the latest published one
    universe_snapshots: [
      { scan_run_id: "old", mode: "worldwide", security_id: "s1", rank: 5, market_cap_usd: 9e11 },
    ],
    scan_security_results: [{ scan_run_id: "new", security_id: "s1", market_cap_usd: 40e9 }],
  });
  const client = {
    ...fake.client,
    from: fake.client.from.bind(fake.client),
    rpc: () =>
      Promise.resolve({ data: [{ security_id: "s1", signal_security_id: "s1" }], error: null }),
  } as never;
  const rows = await createRiskSetStore(client).holdings();
  assertEquals(rows, [
    { userId: "u1", securityId: "s1", isOperating: true, worldwideRank: null, marketCapUsd: 40e9 },
  ]);
});
