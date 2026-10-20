import { assert, assertEquals } from "@std/assert";
import { createFakeClock } from "./clock.ts";
import {
  CATALOGUE_ENDPOINT,
  CATALOGUE_REFERER,
  CATALOGUE_USER_AGENT,
  type CatalogueFetch,
  createFixtureCatalogueFetch,
  createImportBudget,
  fetchExchangeProducts,
  mapProduct,
  PAGE_SIZE,
  retryAfterMs,
} from "./ibkr-catalogue.ts";

const fixture = async (name: string): Promise<{ products: unknown[]; productCount: number }> =>
  JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url)));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

interface Call {
  url: string;
  init: RequestInit;
  at: number;
  body: {
    domain: string;
    exchangeId: string;
    pageNumber: number;
    pageSize: number;
    sortDirection: string;
    sortField: string;
  };
}

/** A scripted fetch: each entry answers one request in order; the last entry repeats. Records every call with the fake time. */
function harness(
  script: Array<Response | Error | ((call: Call) => Response)>,
  budgetOpts?: { maxPages?: number; maxRequests?: number },
) {
  const clock = createFakeClock();
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: CatalogueFetch = (url, init = {}) => {
    const call: Call = { url, init, at: clock.now(), body: JSON.parse(String(init.body)) };
    calls.push(call);
    const next = script[Math.min(i++, script.length - 1)] as
      | Response
      | Error
      | ((c: Call) => Response);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "function" ? next(call) : next.clone());
  };
  const budget = createImportBudget(budgetOpts);
  const deps = {
    fetchImpl,
    clock,
    pause: (ms: number) => clock.sleep(ms),
    budget,
    fetchedAt: "2026-10-15T07:00:00.000Z",
  };
  return { clock, calls, deps, budget };
}

const filler = (page: number): unknown[] =>
  Array.from({ length: PAGE_SIZE }, (_, n) => ({
    type: "ETF",
    symbol: `F${page}_${n}`,
    localSymbol: `F${page}_${n}`,
    conid: page * 1000 + n + 1,
    currency: "EUR",
  }));

Deno.test("IBIS fixture: only EUR stocks are kept, mapped to ibkr_catalogue columns; the request is exactly what the research probe sent", async () => {
  const page = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = harness([json(page)]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, true);
  assertEquals(r.aborted, null);
  assertEquals(r.scanned, 5);
  assertEquals(r.productCount, 5);
  assertEquals(r.skipped, { wrong_type: 1, wrong_currency: 1, invalid: 0 });
  assertEquals(
    r.rows.map((x) => [x.local_symbol, x.conid, x.isin]),
    [
      ["MSF", 12178239, "US5949181045"],
      ["APC", 13013300, "US0378331005"],
      ["SAP", 14204, "DE0007164600"],
    ],
  );
  assertEquals(r.rows[0], {
    exchange_id: "IBIS",
    conid: 12178239,
    symbol: "MSF",
    local_symbol: "MSF",
    isin: "US5949181045",
    currency: "EUR",
    description: "MICROSOFT CORP",
    product_type: "STK",
    fetched_at: "2026-10-15T07:00:00.000Z",
  });

  assertEquals(h.calls.length, 1);
  const call = h.calls[0] as Call;
  assertEquals(call.url, CATALOGUE_ENDPOINT);
  assertEquals(call.init.method, "POST");
  assertEquals(call.body, {
    domain: "com",
    exchangeId: "IBIS",
    pageNumber: 1,
    pageSize: 100,
    sortDirection: "asc",
    sortField: "symbol",
  });
  assertEquals(Object.keys(call.body), [
    "domain",
    "exchangeId",
    "pageNumber",
    "pageSize",
    "sortDirection",
    "sortField",
  ]);
  const headers = call.init.headers as Record<string, string>;
  assertEquals(headers["Content-Type"], "application/json");
  assertEquals(headers["Referer"], CATALOGUE_REFERER);
  assertEquals(headers["User-Agent"], CATALOGUE_USER_AGENT);
  assert(
    CATALOGUE_USER_AGENT.includes("personal-stock-screener"),
    "a descriptive User-Agent identifies the importer",
  );
});

Deno.test("AEB fixture: Unilever keeps symbol UNVB and localSymbol UNA; the IOPT tracker row is dropped", async () => {
  const page = await fixture("ibkr-catalogue-aeb-page1.json");
  const r = await fetchExchangeProducts("AEB", harness([json(page)]).deps);
  assertEquals(
    r.rows.map((x) => [x.symbol, x.local_symbol, x.conid]),
    [
      ["ADYEN", "ADYEN", 321202935],
      ["ASML", "ASML", 117589399],
      ["UNVB", "UNA", 837455595],
    ],
  );
  assertEquals(r.skipped.wrong_type, 1);
  assert(
    r.rows.every(
      (x) => x.exchange_id === "AEB" && x.currency === "EUR" && x.product_type === "STK",
    ),
  );
});

Deno.test("mapProduct: rejects malformed rows, normalises the ISIN, never throws", () => {
  const ok = {
    type: "STK",
    symbol: " MSF ",
    localSymbol: "MSF",
    conid: "12178239",
    currency: "EUR",
    isin: "us5949181045",
    description: "  ",
  };
  const mapped = mapProduct(ok, "IBIS", "t");
  assert("row" in mapped);
  if ("row" in mapped) {
    assertEquals(
      [mapped.row.symbol, mapped.row.conid, mapped.row.isin, mapped.row.description],
      ["MSF", 12178239, "US5949181045", null],
    );
  }
  assertEquals(mapProduct({ ...ok, isin: "not-an-isin" }, "IBIS", "t"), {
    row: {
      exchange_id: "IBIS",
      conid: 12178239,
      symbol: "MSF",
      local_symbol: "MSF",
      isin: null,
      currency: "EUR",
      description: null,
      product_type: "STK",
      fetched_at: "t",
    },
  });
  for (const bad of [
    null,
    5,
    [],
    {},
    { ...ok, conid: 0 },
    { ...ok, conid: 1.5 },
    { ...ok, symbol: "" },
    { ...ok, localSymbol: undefined },
  ]) {
    assertEquals("skip" in mapProduct(bad, "IBIS", "t"), true);
  }
  assertEquals(mapProduct({ ...ok, type: "ETF" }, "IBIS", "t"), { skip: "wrong_type" });
  assertEquals(mapProduct({ ...ok, currency: "USD" }, "IBIS", "t"), { skip: "wrong_currency" });
});

Deno.test("pagination: a full page is followed by the next page, a short page ends it, requests are 300 ms apart", async () => {
  const last = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = harness([json({ products: filler(1), productCount: 105 }), json(last)]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, true);
  assertEquals(
    h.calls.map((c) => c.body.pageNumber),
    [1, 2],
  );
  assertEquals(r.pages, 2);
  assertEquals(r.scanned, 105);
  assertEquals(r.rows.length, 3);
  assert((h.calls[1] as Call).at - (h.calls[0] as Call).at >= 300, "300 ms spacing");
});

Deno.test("pagination: a full last page is confirmed by productCount, an empty page also ends it", async () => {
  const a = harness([json({ products: filler(1), productCount: 100 })]);
  assertEquals((await fetchExchangeProducts("IBIS", a.deps)).complete, true);
  assertEquals(a.calls.length, 1, "productCount reached, no extra request");

  const b = harness([json({ products: filler(1) }), json({ products: [] })]);
  const r = await fetchExchangeProducts("IBIS", b.deps);
  assertEquals(r.complete, true);
  assertEquals(b.calls.length, 2);
});

Deno.test("pagination: a short page is not the end while productCount says more products exist", async () => {
  const half = (page: number, n: number): unknown[] => filler(page).slice(0, n);
  const h = harness([
    json({ products: half(1, 50), productCount: 120 }),
    json({ products: half(2, 50), productCount: 120 }),
    json({ products: half(3, 20), productCount: 120 }),
  ]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.scanned, 120);
  assertEquals(r.complete, true);
  assertEquals(h.calls.length, 3);

  const empty = harness([
    json({ products: half(1, 50), productCount: 120 }),
    json({ products: [] }),
  ]);
  const e = await fetchExchangeProducts("IBIS", empty.deps);
  assertEquals(e.complete, false, "an empty page before productCount is reached is not complete");
});

Deno.test("spacing holds across exchanges because the budget is shared", async () => {
  const ibis = await fixture("ibkr-catalogue-ibis-page1.json");
  const aeb = await fixture("ibkr-catalogue-aeb-page1.json");
  const fetchImpl = createFixtureCatalogueFetch({ IBIS: [ibis.products], AEB: [aeb.products] });
  const clock = createFakeClock();
  const starts: number[] = [];
  const spy: CatalogueFetch = (url, init) => {
    starts.push(clock.now());
    return fetchImpl(url, init);
  };
  const budget = createImportBudget();
  const deps = { fetchImpl: spy, clock, pause: (ms: number) => clock.sleep(ms), budget };
  await fetchExchangeProducts("IBIS", deps);
  const second = await fetchExchangeProducts("AEB", deps);
  assertEquals(second.rows.length, 3);
  assertEquals(starts.length, 2);
  assert((starts[1] as number) - (starts[0] as number) >= 300);
  assertEquals([budget.pages, budget.requests], [2, 2]);
});

Deno.test("HTTP 500 is retried exactly 3 times with 1 s, 2 s and 4 s backoff, then the import is abandoned (no 5th request)", async () => {
  const h = harness([new Response("boom", { status: 500 })]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(h.calls.length, 4);
  assertEquals(r.complete, false);
  assertEquals(r.aborted, { reason: "http_error", status: 500, page: 1 });
  assertEquals(r.rows, []);
  assertEquals(
    h.clock.sleeps.filter((ms) => ms >= 1000),
    [1000, 2000, 4000],
  );
});

Deno.test("a 429 with Retry-After waits for the longer of the header and the backoff, then continues", async () => {
  const page = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = harness([
    new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    json(page),
  ]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, true);
  assertEquals(h.calls.length, 2);
  assert(h.clock.sleeps.includes(7000));
  assertEquals(retryAfterMs(new Response(null, { headers: { "retry-after": "9999" } })), 60_000);
  assertEquals(
    retryAfterMs(
      new Response(null, { headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
    ),
    null,
  );
});

Deno.test("a 403 or 404 is not retried at all", async () => {
  for (const status of [403, 404, 400]) {
    const h = harness([new Response("no", { status })]);
    const r = await fetchExchangeProducts("IBIS", h.deps);
    assertEquals(h.calls.length, 1);
    assertEquals(r.aborted?.reason, "http_error");
    assertEquals(r.aborted?.status, status);
  }
});

Deno.test("a network error is retried once and then succeeds; a persistent one aborts after 4 attempts", async () => {
  const page = await fixture("ibkr-catalogue-ibis-page1.json");
  const a = harness([new TypeError("connection reset"), json(page)]);
  assertEquals((await fetchExchangeProducts("IBIS", a.deps)).complete, true);
  assertEquals(a.calls.length, 2);

  const b = harness([new TypeError("down")]);
  const r = await fetchExchangeProducts("IBIS", b.deps);
  assertEquals(b.calls.length, 4);
  assertEquals(r.aborted, { reason: "network_error", status: null, page: 1 });
});

Deno.test("an unexpected body is not retried: invalid JSON and a missing products array abort at once", async () => {
  const a = harness([new Response("<html>maintenance</html>", { status: 200 })]);
  assertEquals((await fetchExchangeProducts("IBIS", a.deps)).aborted?.reason, "bad_shape");
  assertEquals(a.calls.length, 1);
  const b = harness([json({ error: "nope" })]);
  assertEquals((await fetchExchangeProducts("IBIS", b.deps)).aborted?.reason, "bad_shape");
});

Deno.test("an abort after page 1 keeps the rows read so far but is never complete", async () => {
  const h = harness([
    json({ products: filler(1), productCount: 250 }),
    new Response("x", { status: 503 }),
  ]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, false);
  assertEquals(r.pages, 1);
  assertEquals(r.aborted?.page, 2);
  assertEquals(h.calls.length, 1 + 4);
});

Deno.test("the page budget stops an endless catalogue at maxPages", async () => {
  const h = harness(
    [(call) => json({ products: filler(call.body.pageNumber), productCount: 99999 })],
    { maxPages: 3 },
  );
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.pages, 3);
  assertEquals(r.complete, false);
  assertEquals(r.aborted, { reason: "page_budget", status: null, page: 4 });
  assertEquals(h.calls.length, 3);
});

Deno.test("the request budget caps retries across the whole import: a flapping endpoint cannot be hammered", async () => {
  const h = harness([new Response("x", { status: 500 })], { maxRequests: 3 });
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(h.calls.length, 3);
  assertEquals(r.aborted?.reason, "request_budget");
  // a second exchange sharing the budget makes no request at all
  const second = await fetchExchangeProducts("AEB", h.deps);
  assertEquals(h.calls.length, 3);
  assertEquals(second.aborted?.reason, "request_budget");
});

Deno.test("an aborted signal stops before the next request", async () => {
  const h = harness([json({ products: filler(1), productCount: 500 })]);
  const ctl = new AbortController();
  const deps = {
    ...h.deps,
    signal: ctl.signal,
    pause: async (ms: number) => {
      ctl.abort();
      await h.clock.sleep(ms);
    },
  };
  const r = await fetchExchangeProducts("IBIS", deps);
  assertEquals(r.aborted?.reason, "aborted");
  assertEquals(h.calls.length, 1);
});

Deno.test("createFixtureCatalogueFetch serves pages by exchange and page number", async () => {
  const f = createFixtureCatalogueFetch({ IBIS: [[{ a: 1 }], [{ a: 2 }]] });
  const res = await f(CATALOGUE_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ exchangeId: "IBIS", pageNumber: 2 }),
  });
  assertEquals((await res.json()).products, [{ a: 2 }]);
  const empty = await f(CATALOGUE_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ exchangeId: "NOPE", pageNumber: 1 }),
  });
  assertEquals((await empty.json()).products, []);
});

Deno.test("a request that never answers is aborted by the per-request timeout and retried like a network error", async () => {
  const h = harness([new TypeError("unused")]);
  let calls = 0;
  const hanging = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  const r = await fetchExchangeProducts("IBIS", {
    ...h.deps,
    fetchImpl: hanging as unknown as typeof h.deps.fetchImpl,
    requestTimeoutMs: 10,
  });
  assertEquals(calls, 4);
  assertEquals(r.aborted?.reason, "network_error");
});
