import { assert, assertEquals, assertRejects } from "@std/assert";
import { type ChartMeta, cleanBars, sessionDay } from "../core/bars.ts";
import { isoDate } from "../core/calendar.ts";
import { createFakeClock } from "./clock.ts";
import { jsonResponse, readFixture, routeFetch } from "./fixtures.ts";
import { createMemoryKv } from "./store.ts";
import { YahooUnavailableError } from "./throttle.ts";
import {
  chunk,
  collectScreenerPages,
  createYahooProvider,
  isSessionUrl,
  mapChart,
  mapProfile,
  mapQuote,
  mapSearch,
  stripCrumb,
  toMs,
  type YahooClientLike,
  YahooHttpError,
  YahooSchemaError,
} from "./yahoo.ts";

const utc = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------------------- mapping against recorded samples

Deno.test("toMs reads Date, ISO strings, epoch seconds and epoch milliseconds", () => {
  const ms = Date.UTC(2026, 9, 15, 7, 27, 36);
  assertEquals(toMs(new Date(ms)), ms);
  assertEquals(toMs("2026-10-15T07:27:36.000Z"), ms);
  assertEquals(toMs(ms / 1000, "s"), ms);
  assertEquals(toMs(ms, "ms"), ms);
  assertEquals(toMs(Number.NaN), null);
  assertEquals(toMs("garbage"), null);
  assertEquals(toMs(null), null);
});

Deno.test("mapQuote: twelve recorded quote records, SHEL.L keeps currency GBp and a GBP market cap", async () => {
  const rows = await readFixture<unknown[]>("yahoo/quote_12.trim.json");
  const mapped = rows.map(mapQuote);
  assertEquals(mapped.filter((m) => m === null).length, 0);
  const shel = mapped.find((m) => m?.symbol === "SHEL.L");
  assertEquals(shel?.currency, "GBp");
  assertEquals(shel?.financialCurrency, "USD");
  assertEquals(shel?.marketCap, 222044831744); // already GBP: never divided by 100
  assertEquals(shel?.exchange, "LSE");
  const aapl = mapped.find((m) => m?.symbol === "AAPL");
  assertEquals(aapl?.quoteType, "EQUITY");
  assertEquals(aapl?.exchangeTimezoneName, "America/New_York");
  assertEquals(aapl?.firstTradeDateMs, utc("1980-12-12T14:30:00.000Z"));
  assertEquals(aapl?.regularMarketTime, utc("2026-10-14T20:00:01.000Z"));
  assertEquals(aapl?.averageDailyVolume3Month, 45112966);
});

Deno.test("mapQuote: raw screener rows carry epoch seconds and epoch milliseconds", async () => {
  const page = await readFixture<{ quotes: Array<Record<string, unknown>> }>(
    "yahoo/screener_gb.trim.json",
  );
  const first = page.quotes[0]!;
  const mapped = mapQuote(first);
  assert(mapped !== null);
  assertEquals(mapped.regularMarketTime, (first["regularMarketTime"] as number) * 1000);
  assertEquals(mapped.firstTradeDateMs, first["firstTradeDateMilliseconds"] as number);
});

Deno.test("mapQuote returns null (schema drift) when an identity field is missing", () => {
  assertEquals(mapQuote({ symbol: "X", currency: "USD", exchange: "NMS" }), null);
  assertEquals(mapQuote({ currency: "USD", exchange: "NMS", quoteType: "EQUITY" }), null);
  assertEquals(mapQuote("nope"), null);
});

Deno.test("mapChart: SAP.DE keeps the null bar and exposes the trading period in epoch ms", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_SAP.DE.trim.json"));
  assertEquals(chart.meta.exchangeTimezoneName, "Europe/Berlin");
  assertEquals(chart.meta.currentTradingPeriod, {
    start: utc("2026-10-15T07:00:00Z"),
    end: utc("2026-10-15T15:30:00Z"),
  });
  assertEquals(chart.meta.regularMarketTime, utc("2026-10-15T07:27:36Z"));
  assertEquals(chart.bars.length, 40);
  const nullBar = chart.bars.find((b) => b.time === utc("2026-10-14T07:00:00Z"));
  assertEquals(nullBar?.close, null);
  assertEquals(chart.splits, []);
});

Deno.test("mapChart + cleanBars on the recorded SAP.DE sample: the forming bar and the null bar never reach the series", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_SAP.DE.trim.json"));
  const meta: ChartMeta = {
    exchangeTimezoneName: chart.meta.exchangeTimezoneName,
    regularMarketTime: chart.meta.regularMarketTime,
    currentTradingPeriod: chart.meta.currentTradingPeriod,
    marketState: "REGULAR",
  };
  const { series, report } = cleanBars(chart.bars, meta, utc("2026-10-15T07:42:00Z"));
  assertEquals(report.droppedForming, true);
  assertEquals(report.droppedNullClose, 1);
  assertEquals(isoDate(series.dates[series.dates.length - 1]!), "2026-10-13");
  assert(
    !series.close.includes(199.6199951171875),
    "the forming 2026-10-15 close must not be stored",
  );
});

Deno.test("mapChart + cleanBars on AAPL and 7203.T: the last bar is a completed session", async () => {
  const aapl = mapChart(await readFixture("yahoo/chart_AAPL.trim.json"));
  const a = cleanBars(
    aapl.bars,
    { ...aapl.meta, marketState: "PREPRE" },
    utc("2026-10-15T07:42:00Z"),
  );
  assertEquals(a.report.droppedForming, false);
  assertEquals(isoDate(a.series.dates[a.series.dates.length - 1]!), "2026-10-14");

  const toyota = mapChart(await readFixture("yahoo/chart_7203.T.trim.json"));
  const t = cleanBars(
    toyota.bars,
    { ...toyota.meta, marketState: "POSTPOST" },
    utc("2026-10-15T07:42:00Z"),
  );
  assertEquals(t.report.droppedForming, false);
  assertEquals(isoDate(t.series.dates[t.series.dates.length - 1]!), "2026-10-15");
});

Deno.test("mapChart: NVDA 4:1 and 10:1 splits are reported and close is continuous across 2024-06-07/10 (no jump)", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_NVDA.trim.json"));
  assertEquals(chart.splits, [
    { dateMs: utc("2021-07-20T13:30:00Z"), numerator: 4, denominator: 1 },
    { dateMs: utc("2024-06-10T13:30:00Z"), numerator: 10, denominator: 1 },
  ]);
  const { series, report } = cleanBars(
    chart.bars,
    {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2024-06-12T20:00:00Z"),
      currentTradingPeriod: {
        start: utc("2024-06-13T13:30:00Z"),
        end: utc("2024-06-13T20:00:00Z"),
      },
      marketState: "CLOSED",
    },
    utc("2024-06-13T05:00:00Z"),
  );
  assertEquals(report.jumpAnomalies, 0);
  const i7 = series.dates.indexOf(sessionDay(utc("2024-06-07T13:30:00Z"), "America/New_York"));
  const i10 = series.dates.indexOf(sessionDay(utc("2024-06-10T13:30:00Z"), "America/New_York"));
  assert(i7 >= 0 && i10 === i7 + 1, "2024-06-07 and 2024-06-10 are consecutive sessions");
  assert(Math.abs(series.close[i10]! / series.close[i7]! - 1) < 0.05);
});

Deno.test("mapChart: 0700.HK bars open at 01:30Z, map to the Hong Kong session day, and the in-progress session is dropped at 07:42Z", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_0700.HK.trim.json"));
  const last = chart.bars[chart.bars.length - 1]!;
  assertEquals(new Date(last.time).toISOString().slice(11, 16), "01:30");
  assertEquals(isoDate(sessionDay(last.time, "Asia/Hong_Kong")), "2026-10-15");
  const { series, report } = cleanBars(
    chart.bars,
    { ...chart.meta, marketState: "REGULAR" },
    utc("2026-10-15T07:42:00Z"),
  );
  assertEquals(report.droppedForming, true); // the Hong Kong session runs until 08:00Z
  assertEquals(isoDate(series.dates[series.dates.length - 1]!), "2026-10-14");
});

Deno.test("mapChart rejects a payload without a timezone (session days could not be derived)", () => {
  let threw = false;
  try {
    mapChart({ meta: { currency: "USD" }, quotes: [] });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("mapSearch and mapProfile on recorded samples", async () => {
  const s = mapSearch(await readFixture("yahoo/search_US5949181045.trim.json"));
  assertEquals(
    s.hits.map((h) => [h.symbol, h.exchange, h.quoteType, h.sector]),
    [["MSFT", "NMS", "EQUITY", "Technology"]],
  );
  assertEquals(s.news.length, 2);
  assert(s.news[0]!.relatedTickers.length > 0);
  assert(s.news[0]!.publishedMs > 0);

  const p = mapProfile("SAP.DE", await readFixture("yahoo/quoteSummary_SAP.DE.trim.json"));
  assertEquals(
    [p.country, p.sector, p.industry],
    ["Germany", "Technology", "Software - Application"],
  );
  assert(p.summary !== null && p.summary.length <= 200);
});

Deno.test("chunk splits 1,200 symbols into 500 + 500 + 200", () => {
  assertEquals(
    chunk(
      Array.from({ length: 1200 }, (_, i) => i),
      500,
    ).map((c) => c.length),
    [500, 500, 200],
  );
  assertEquals(chunk([], 500), []);
});

// ---------------------------------------------------------------------------- provider with an injected client

function fakeClient(over: Partial<YahooClientLike> = {}) {
  const calls = {
    quote: [] as Array<{ symbols: string[]; fields: string[] | undefined }>,
    chart: [] as Array<Record<string, unknown>>,
  };
  const client: YahooClientLike = {
    quote: (symbols, query) => {
      calls.quote.push({ symbols, fields: query.fields });
      return Promise.resolve(
        symbols
          .filter((s) => s !== "UNKNOWN")
          .map((symbol) => ({
            symbol,
            currency: "USD",
            exchange: "NMS",
            quoteType: "EQUITY",
            marketCap: 1,
          })),
      );
    },
    chart: (_symbol, query) => {
      calls.chart.push(query);
      return readFixture("yahoo/chart_AAPL.trim.json");
    },
    search: () => readFixture("yahoo/search_US5949181045.trim.json"),
    quoteSummary: () => readFixture("yahoo/quoteSummary_SAP.DE.trim.json"),
    ...over,
  };
  return { client, calls };
}

function providerWith(
  client: YahooClientLike,
  fetchImpl = routeFetch([]),
  extra: Record<string, unknown> = {},
) {
  const clock = createFakeClock();
  const store = createMemoryKv(clock);
  const events: Array<[string, Record<string, unknown>]> = [];
  const provider = createYahooProvider({
    fetchImpl,
    store,
    clock,
    client,
    rng: () => 0.5,
    onEvent: (e, d) => events.push([e, d]),
    ...extra,
  });
  return { provider, clock, store, events };
}

Deno.test("quote: 1,200 unique symbols go out as 3 calls of 500, 500 and 200; duplicates are removed; unknown symbols are omitted", async () => {
  const { client, calls } = fakeClient();
  const { provider } = providerWith(client);
  const symbols = Array.from({ length: 1200 }, (_, i) => `S${i}`);
  const rows = await provider.quote([...symbols, ...symbols.slice(0, 10), "UNKNOWN"]);
  assertEquals(
    calls.quote.map((c) => c.symbols.length),
    [500, 500, 201],
  );
  assertEquals(rows.length, 1200);
  assert(!rows.some((r) => r.symbol === "UNKNOWN"));
  assert(calls.quote[0]!.fields!.includes("marketCap"));
});

Deno.test("quote: a row without identity fields is dropped and counted as schema drift", async () => {
  const { client } = fakeClient({
    quote: () =>
      Promise.resolve([
        { symbol: "A", currency: "USD", exchange: "NMS", quoteType: "EQUITY" },
        { currency: "USD" },
      ]),
  });
  const { provider, events } = providerWith(client);
  const rows = await provider.quote(["A", "B"]);
  assertEquals(rows.length, 1);
  assertEquals(provider.stats().schemaDrift, 1);
  assertEquals(events[0]?.[0], "yahoo_schema_drift");
});

Deno.test("quote of no symbols makes no call", async () => {
  const { client, calls } = fakeClient();
  const { provider } = providerWith(client);
  assertEquals(await provider.quote([]), []);
  assertEquals(calls.quote.length, 0);
});

Deno.test("chart: requests daily bars with the given events and period1 and maps the result", async () => {
  const { client, calls } = fakeClient();
  const { provider } = providerWith(client);
  const res = await provider.chart("AAPL", {
    period1: "2013-10-15",
    interval: "1d",
    events: "split",
  });
  assertEquals(calls.chart[0], { period1: "2013-10-15", interval: "1d", events: "split" });
  assertEquals(res.bars.length, 40);
  assertEquals(res.meta.exchangeTimezoneName, "America/New_York");
});

Deno.test("profile, search and news go through the client", async () => {
  const { client } = fakeClient();
  const { provider } = providerWith(client);
  assertEquals((await provider.profile("SAP.DE")).country, "Germany");
  assertEquals((await provider.search("US5949181045")).hits[0]?.symbol, "MSFT");
  assertEquals((await provider.news("MSFT", 50)).length, 2);
});

// ---------------------------------------------------------------------------- raw screener

interface ScreenerWorld {
  fetchImpl: ReturnType<typeof routeFetch>;
  bodies: Array<Record<string, unknown>>;
  count: { cookie: number; crumb: number; screener: number };
}

function screenerWorld(
  rows: Array<Record<string, unknown>>,
  opts: { unauthorizedFirst?: number; status?: number } = {},
): ScreenerWorld {
  const count = { cookie: 0, crumb: 0, screener: 0 };
  const bodies: Array<Record<string, unknown>> = [];
  let unauthorized = opts.unauthorizedFirst ?? 0;
  const fetchImpl = routeFetch([
    {
      match: (u) => u.host === "fc.yahoo.com",
      respond: () => {
        count.cookie++;
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie":
              "A3=d=TESTCOOKIE; Expires=Wed, 15 Oct 2027 07:00:00 GMT; Domain=.yahoo.com; Path=/",
          },
        });
      },
    },
    {
      match: (u) => u.pathname === "/v1/test/getcrumb",
      respond: (_u, init) => {
        count.crumb++;
        const cookie = new Headers(init?.headers).get("cookie");
        return cookie === "A3=d=TESTCOOKIE"
          ? new Response("CRUMB123456", { status: 200 })
          : new Response("no cookie", { status: 401 });
      },
    },
    {
      match: (u) => u.pathname === "/v1/finance/screener",
      respond: async (u, init) => {
        count.screener++;
        assertEquals(
          u.searchParams.get("crumb"),
          count.cookie > 1 && opts.unauthorizedFirst ? "CRUMB123456" : "CRUMB123456",
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (opts.status !== undefined) return new Response("limited", { status: opts.status });
        if (unauthorized > 0) {
          unauthorized--;
          return jsonResponse(
            { error: { code: "Unauthorized", description: "Invalid Crumb" } },
            401,
          );
        }
        const offset = body["offset"] as number;
        const size = body["size"] as number;
        const slice = rows.slice(offset, offset + size);
        return jsonResponse({
          finance: {
            result: [
              {
                start: offset,
                count: slice.length,
                total: rows.length,
                quotes: slice,
                useRecords: false,
              },
            ],
            error: null,
          },
        });
      },
    },
  ]);
  return { fetchImpl, bodies, count };
}

async function sampleRows(): Promise<Array<Record<string, unknown>>> {
  const gb = await readFixture<{ quotes: Array<Record<string, unknown>> }>(
    "yahoo/screener_gb.trim.json",
  );
  return gb.quotes;
}

Deno.test("screen: posts the per-exchange query with cookie and crumb and maps the page", async () => {
  const world = screenerWorld(await sampleRows());
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const page = await provider.screen({
    exchange: "LSE",
    minMarketCapLocal: 35e9,
    offset: 0,
    size: 250,
  });
  assertEquals(page.total, 5);
  assertEquals(page.count, 5);
  assertEquals(page.rows.length, 5);
  assertEquals(world.bodies[0], {
    size: 250,
    offset: 0,
    sortField: "intradaymarketcap",
    sortType: "DESC",
    quoteType: "EQUITY",
    query: {
      operator: "and",
      operands: [
        { operator: "gt", operands: ["intradaymarketcap", 35e9] },
        { operator: "eq", operands: ["exchange", "LSE"] },
      ],
    },
    userId: "",
    userIdType: "guid",
  });
});

Deno.test("collectScreenerPages: two pages are walked until offset >= total", async () => {
  const world = screenerWorld(await sampleRows());
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const res = await collectScreenerPages(provider, {
    exchange: "LSE",
    minMarketCapLocal: 35e9,
    size: 3,
    maxPages: 10,
  });
  assertEquals(res.pages, 2);
  assertEquals(res.rows.length, 5);
  assertEquals(res.total, 5);
  assertEquals(res.nextOffset, null);
  assertEquals(
    world.bodies.map((b) => b["offset"]),
    [0, 3],
  );
  assertEquals(
    world.count.cookie,
    1,
    "the session is acquired once and cached for the second page",
  );
});

Deno.test("collectScreenerPages: maxPages truncates and reports where to continue", async () => {
  const world = screenerWorld(await sampleRows());
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const res = await collectScreenerPages(provider, {
    exchange: "LSE",
    minMarketCapLocal: 35e9,
    size: 2,
    maxPages: 2,
  });
  assertEquals(res.pages, 2);
  assertEquals(res.rows.length, 4);
  assertEquals(res.nextOffset, 4);
});

Deno.test("screen: an empty page ends the walk", async () => {
  const world = screenerWorld([]);
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const res = await collectScreenerPages(provider, {
    exchange: "XXX",
    minMarketCapLocal: 1,
    maxPages: 5,
  });
  assertEquals(res.pages, 1);
  assertEquals(res.rows, []);
});

Deno.test("screen: HTTP 401 Invalid Crumb discards the session, reacquires once and retries", async () => {
  const world = screenerWorld(await sampleRows(), { unauthorizedFirst: 1 });
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const page = await provider.screen({
    exchange: "LSE",
    minMarketCapLocal: 1,
    offset: 0,
    size: 250,
  });
  assertEquals(page.rows.length, 5);
  assertEquals(world.count.cookie, 2, "one reacquire");
  assertEquals(world.count.screener, 2);
});

Deno.test("screen: a second 401 is an error, not a loop", async () => {
  const world = screenerWorld(await sampleRows(), { unauthorizedFirst: 5 });
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const err = await assertRejects(
    () => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }),
    YahooHttpError,
  );
  assertEquals(err.status, 401);
  assertEquals(world.count.screener, 2);
});

Deno.test("screen: a cached session is restored by a new provider instance (no cookie request)", async () => {
  const world = screenerWorld(await sampleRows());
  const clock = createFakeClock();
  const store = createMemoryKv(clock);
  const make = () =>
    createYahooProvider({
      fetchImpl: world.fetchImpl,
      store,
      clock,
      client: fakeClient().client,
      rng: () => 0.5,
    });
  await make().screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  await make().screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  assertEquals(world.count.cookie, 1);
});

Deno.test("screen: size above 250 is rejected before any request", async () => {
  const world = screenerWorld([]);
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  let threw = false;
  try {
    await provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 500 });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw);
  assertEquals(world.fetchImpl.calls.length, 0);
});

Deno.test("429 storm: the call retries, then the breaker opens and the next call fails fast without a request", async () => {
  const world = screenerWorld(await sampleRows(), { status: 429 });
  const { provider, events } = providerWith(fakeClient().client, world.fetchImpl, {
    budgetMs: 1e12,
  });
  const err = await assertRejects(
    () => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }),
    YahooHttpError,
  );
  assertEquals(err.status, 429);
  assertEquals(world.count.screener, 4);
  await assertRejects(
    () => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }),
    YahooUnavailableError,
  );
  const before = world.fetchImpl.calls.length;
  await assertRejects(
    () => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }),
    YahooUnavailableError,
  );
  assertEquals(world.fetchImpl.calls.length, before);
  assert(events.some(([e]) => e === "yahoo_breaker_open"));
  assertEquals(provider.stats().status429, 5);
});

Deno.test("recorder: responses are recorded with the crumb stripped; without a recorder nothing is recorded", async () => {
  const world = screenerWorld(await sampleRows());
  const entries: Array<{ method: string; url: string; status: number; body: string }> = [];
  const { provider } = providerWith(fakeClient().client, world.fetchImpl, {
    recorder: (e: { method: string; url: string; status: number; body: string }) => {
      entries.push(e);
      return Promise.resolve();
    },
  });
  await provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  const screener = entries.find((e) => e.url.includes("/v1/finance/screener"));
  assert(screener !== undefined);
  assert(!screener.url.includes("CRUMB123456"));
  assert(screener.url.includes("crumb=REDACTED"));
  assertEquals(screener.method, "POST");
});

Deno.test("recorder: getcrumb and cookie responses are never recorded; every crumb= parameter is redacted", async () => {
  const world = screenerWorld(await sampleRows());
  const entries: Array<{ method: string; url: string; status: number; body: string }> = [];
  const { provider } = providerWith(fakeClient().client, world.fetchImpl, {
    recorder: (e: { method: string; url: string; status: number; body: string }) => {
      entries.push(e);
      return Promise.resolve();
    },
  });
  await provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  assertEquals(world.count.crumb, 1);
  assert(!entries.some((e) => e.url.includes("getcrumb") || e.url.includes("fc.yahoo.com")));
  assert(!entries.some((e) => e.body.includes("CRUMB123456") || e.body.includes("TESTCOOKIE")));
  assertEquals(
    stripCrumb("https://x.test/a?crumb=ONE&b=1&crumb=TWO"),
    "https://x.test/a?crumb=REDACTED&b=1&crumb=REDACTED",
  );
  assert(isSessionUrl("https://fc.yahoo.com/"));
  assert(isSessionUrl("https://query1.finance.yahoo.com/v1/test/getcrumb"));
  assert(!isSessionUrl("https://query1.finance.yahoo.com/v1/finance/screener"));
});

Deno.test("quote: a non-array response is schema drift and an error, not 'all symbols unknown'", async () => {
  const { client } = fakeClient({ quote: () => Promise.resolve({ unexpected: true }) });
  const { provider, events } = providerWith(client);
  await assertRejects(() => provider.quote(["A"]), YahooSchemaError);
  assertEquals(provider.stats().schemaDrift, 1);
  assertEquals(events[0]?.[0], "yahoo_schema_drift");
});
