import { assertEquals } from "@std/assert";
import { dayNumber, isoDate } from "../../_shared/core/calendar.ts";
import { RUN_ID, testCtx } from "../testing/ctx.ts";
import { createFakeSb } from "../testing/fake-sb.ts";
import { handleCompute } from "./compute.ts";

const lastDay = dayNumber(2026, 10, 14);
const bars = Array.from({ length: 40 }, (_, i) => 100 * Math.exp(0.004 * i + 0.01 * Math.sin(i)));

function world(snapshots: Array<Record<string, unknown>>) {
  return createFakeSb({
    securities: [
      {
        id: "s1",
        yahoo_symbol: "AAA",
        quote_type: "EQUITY",
        is_canonical: true,
        exchange_code: "NMS",
        first_trade_date: "1999-01-22",
      },
    ],
    exchanges: [{ code: "NMS", max_gap_days: 5 }],
    price_series: [
      {
        security_id: "s1",
        close: bars,
        high: bars.map((v) => v * 1.01),
        low: bars.map((v) => v * 0.99),
        bar_count: 40,
        last_session_date: isoDate(lastDay),
        completeness: {},
      },
    ],
    market_cap_snapshots: snapshots,
    scan_security_results: [],
  });
}

Deno.test("compute reads today's market-cap snapshot, never a previous run's", async () => {
  const sb = world([
    // yesterday's snapshot (below the threshold) comes last, so an unfiltered read would pick it
    {
      scan_run_id: RUN_ID,
      security_id: "s1",
      market_cap_native: 1e11,
      fx_usd_per_unit: 1,
      price_time: "2026-10-14T20:00:00Z",
    },
    {
      scan_run_id: "run-yesterday",
      security_id: "s1",
      market_cap_native: 1e9,
      fx_usd_per_unit: 1,
      price_time: "2026-10-13T20:00:00Z",
    },
  ]);
  await handleCompute(testCtx(sb, { securityIds: ["s1"] }));
  const row = sb.tables["scan_security_results"]?.[0];
  assertEquals(row?.["market_cap_usd"], 1e11);
  assertEquals(row?.["reason_codes"].includes("market_cap_below_threshold"), false);
});

Deno.test("compute without a snapshot of today does not fall back to an older one", async () => {
  const sb = world([
    {
      scan_run_id: "run-yesterday",
      security_id: "s1",
      market_cap_native: 1e11,
      fx_usd_per_unit: 1,
      price_time: "2026-10-13T20:00:00Z",
    },
  ]);
  await handleCompute(testCtx(sb, { securityIds: ["s1"] }));
  const row = sb.tables["scan_security_results"]?.[0];
  assertEquals(row?.["market_cap_usd"], null);
  assertEquals(row?.["tier1_member"], false);
});

function noSeriesWorld(noBarsScans: number) {
  return createFakeSb({
    securities: [
      {
        id: "s1",
        yahoo_symbol: "AAA",
        quote_type: "EQUITY",
        is_canonical: true,
        exchange_code: "NMS",
        first_trade_date: "1999-01-22",
        no_bars_scans: noBarsScans,
      },
    ],
    exchanges: [{ code: "NMS", max_gap_days: 5 }],
    price_series: [],
    market_cap_snapshots: [],
    scan_security_results: [],
  });
}

Deno.test("compute without a series fails the listing while the no-bars streak is below three", async () => {
  const sb = noSeriesWorld(2);
  const ctx = testCtx(sb, { securityIds: ["s1"] });
  const result = await handleCompute(ctx);
  const row = sb.tables["scan_security_results"]?.[0];
  assertEquals(row?.["status"], "failed");
  assertEquals(row?.["reason_codes"], ["unprocessed"]);
  assertEquals((result as Record<string, number>)["failed"], 1);
  assertEquals(ctx.events, ["security_failed"]);
});

Deno.test("compute skips a listing after three scans without price bars", async () => {
  const sb = noSeriesWorld(3);
  const ctx = testCtx(sb, { securityIds: ["s1"] });
  const result = await handleCompute(ctx);
  const row = sb.tables["scan_security_results"]?.[0];
  assertEquals(row?.["status"], "skipped");
  assertEquals(row?.["reason_codes"], ["no_price_data"]);
  assertEquals(row?.["tier1_member"], false);
  assertEquals((result as Record<string, number>)["skipped"], 1);
  assertEquals((result as Record<string, number>)["failed"], 0);
  assertEquals(ctx.events, ["security_skipped"]);
});
