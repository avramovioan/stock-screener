import { assertEquals } from "@std/assert";
import type { RawBar } from "../../_shared/core/bars.ts";
import { testCtx } from "../testing/ctx.ts";
import { createFakeSb } from "../testing/fake-sb.ts";
import { handleFetchBars } from "./fetch_bars.ts";

const DAY = 86_400_000;
const firstDay = Date.UTC(2026, 8, 1, 14);

function barList(n: number): RawBar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i;
    return {
      time: firstDay + i * DAY,
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1000,
    };
  });
}

function world(noBarsScans: number, missingScans: number) {
  return createFakeSb({
    securities: [
      {
        id: "s1",
        yahoo_symbol: "AAA",
        exchange_code: "NMS",
        missing_scans: missingScans,
        no_bars_scans: noBarsScans,
      },
    ],
    exchanges: [{ code: "NMS", max_gap_days: 5, session_close_local: null }],
    price_series: [],
  });
}

function ctxWith(sb: ReturnType<typeof world>, bars: RawBar[]) {
  const ctx = testCtx(sb, { securityIds: ["s1"] });
  const market = {
    quote: () => Promise.resolve([]),
    chart: () =>
      Promise.resolve({
        meta: {
          exchangeTimezoneName: "America/New_York",
          regularMarketTime: null,
          currentTradingPeriod: null,
        },
        bars,
        splits: [],
      }),
  };
  return { ...ctx, providers: { ...ctx.providers, market: market as never } };
}

Deno.test("fetch_bars resets no_bars_scans and missing_scans after a successful fetch", async () => {
  const sb = world(2, 1);
  const result = await handleFetchBars(ctxWith(sb, barList(20)));
  assertEquals((result as { failed: number }).failed, 0);
  assertEquals(sb.tables["securities"]?.[0]?.["no_bars_scans"], 0);
  assertEquals(sb.tables["securities"]?.[0]?.["missing_scans"], 0);
});

Deno.test("fetch_bars counts a fetch without bars in no_bars_scans next to missing_scans", async () => {
  const sb = world(2, 1);
  const ctx = ctxWith(sb, []);
  const result = await handleFetchBars(ctx);
  assertEquals((result as { failed: number }).failed, 1);
  assertEquals(sb.tables["securities"]?.[0]?.["no_bars_scans"], 3);
  assertEquals(sb.tables["securities"]?.[0]?.["missing_scans"], 2);
  assertEquals(ctx.events.includes("security_failed"), true);
});

Deno.test("fetch_bars leaves no_bars_scans unchanged on a non-no_bars failure", async () => {
  const sb = world(2, 1);
  const ctx = ctxWith(sb, []);
  const market = {
    quote: () => Promise.resolve([]),
    chart: () => Promise.reject(new Error("boom")),
  };
  const result = await handleFetchBars({
    ...ctx,
    providers: { ...ctx.providers, market: market as never },
  });
  assertEquals((result as { failed: number }).failed, 1);
  assertEquals(sb.tables["securities"]?.[0]?.["no_bars_scans"], 2);
  assertEquals(sb.tables["securities"]?.[0]?.["missing_scans"], 2);
});
