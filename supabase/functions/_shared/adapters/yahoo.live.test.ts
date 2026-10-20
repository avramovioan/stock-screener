// Opt-in live smoke test: YF_LIVE=1 deno test --config supabase/functions/deno.json --allow-net --allow-env <this file>
// Makes about ten requests to Yahoo through the throttle. Not part of the default test run.
import { assert, assertEquals } from "@std/assert";
import { systemClock } from "./clock.ts";
import { createMemoryKv } from "./store.ts";
import { createYahooProvider } from "./yahoo.ts";

const live = Deno.env.get("YF_LIVE") === "1";

Deno.test(
  {
    name: "live: quote, chart, profile and a screener page through the throttle",
    ignore: !live,
    sanitizeOps: false,
    sanitizeResources: false,
  },
  async () => {
    const provider = createYahooProvider({
      fetchImpl: fetch,
      store: createMemoryKv(systemClock),
      clock: systemClock,
    });

    const quotes = await provider.quote(["AAPL", "SHEL.L", "NOT-A-REAL-SYMBOL-XYZ"]);
    assertEquals(quotes.map((q) => q.symbol).sort(), ["AAPL", "SHEL.L"]);
    assertEquals(quotes.find((q) => q.symbol === "SHEL.L")?.currency, "GBp");
    assert((quotes.find((q) => q.symbol === "AAPL")?.marketCap ?? 0) > 1e12);

    const chart = await provider.chart("SAP.DE", {
      period1: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
      interval: "1d",
      events: "split",
    });
    assertEquals(chart.meta.exchangeTimezoneName, "Europe/Berlin");
    assert(chart.bars.length > 10);
    assert(chart.meta.currentTradingPeriod !== null);

    const profile = await provider.profile("SAP.DE");
    assertEquals(profile.country, "Germany");

    const page = await provider.screen({
      exchange: "GER",
      minMarketCapLocal: 35e9,
      offset: 0,
      size: 3,
    });
    assert(page.total > 0 && page.rows.length === 3);
    assert(page.rows.every((r) => r.exchange === "GER"));

    const stats = provider.stats();
    console.log(
      "requests",
      stats.requests,
      "retries",
      stats.retries,
      "429s",
      stats.status429,
      "drift",
      stats.schemaDrift,
    );
  },
);
