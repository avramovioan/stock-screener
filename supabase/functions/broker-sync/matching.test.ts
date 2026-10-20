import { assertEquals } from "@std/assert";
import {
  type MatchPorts,
  matchPosition,
  matchUserPositions,
  orderForMatching,
  type PositionRef,
  pickLine,
  type SecurityLite,
  yahooSymbolFor,
} from "./matching.ts";

const sec = (o: Partial<SecurityLite> & { id: string; yahoo_symbol: string }): SecurityLite => ({
  exchange_code: "NMS",
  currency_major: "USD",
  quote_type: "EQUITY",
  company_id: `c-${o.id}`,
  isin: null,
  is_canonical: true,
  ...o,
});

const pos = (o: Partial<PositionRef> = {}): PositionRef => ({
  id: 1,
  conid: 100001,
  isin: "US0378331005",
  symbol: "AAPL",
  listingExchange: "NASDAQ",
  currency: "USD",
  assetClass: "STK",
  subCategory: "COMMON",
  ...o,
});

interface FakeOpts {
  byIsin?: Record<string, SecurityLite[]>;
  bySymbol?: Record<string, SecurityLite>;
  exchanges?: Record<string, { code: string; yahooSuffix: string | null }>;
  canonical?: Record<string, SecurityLite>;
  search?: Record<string, Array<{ symbol: string; quoteType: string; exchange?: string }>>;
  ensure?: Record<string, SecurityLite | { error: string }>;
}

function ports(o: FakeOpts = {}) {
  const calls = {
    isinSet: [] as Array<[string, string]>,
    searched: [] as string[],
    ensured: [] as string[],
  };
  const p: MatchPorts = {
    securitiesByIsin: (isin) => Promise.resolve(o.byIsin?.[isin] ?? []),
    securityBySymbol: (s) => Promise.resolve(o.bySymbol?.[s] ?? null),
    exchangeByIbkrId: (id) => Promise.resolve(o.exchanges?.[id] ?? null),
    canonicalOf: (companyId) => Promise.resolve(o.canonical?.[companyId] ?? null),
    setSecurityIsin: (id, isin) => (calls.isinSet.push([id, isin]), Promise.resolve()),
    searchIsin: (isin) => (calls.searched.push(isin), Promise.resolve(o.search?.[isin] ?? [])),
    ensureSecurity: (s) => (
      calls.ensured.push(s), Promise.resolve(o.ensure?.[s] ?? { error: "no_quote" })
    ),
  };
  return { p, calls };
}

const NASDAQ = { code: "NMS", yahooSuffix: null };
const IBIS = { code: "GER", yahooSuffix: ".DE" };

Deno.test("yahooSymbolFor applies the exchange suffix and turns IBKR share-class spaces into dashes", () => {
  assertEquals(yahooSymbolFor("AAPL", null), "AAPL");
  assertEquals(yahooSymbolFor("SAP", ".DE"), "SAP.DE");
  assertEquals(yahooSymbolFor("BRK B", null), "BRK-B");
  assertEquals(yahooSymbolFor("sap", ".DE"), "SAP.DE");
});

Deno.test("pickLine prefers the listing exchange, then the position currency, then the canonical line, then the symbol", () => {
  const nms = sec({ id: "1", yahoo_symbol: "MSFT", exchange_code: "NMS", currency_major: "USD" });
  const ger = sec({
    id: "2",
    yahoo_symbol: "MSF.DE",
    exchange_code: "GER",
    currency_major: "EUR",
    is_canonical: false,
  });
  const ams = sec({
    id: "3",
    yahoo_symbol: "MSFT.AS",
    exchange_code: "AMS",
    currency_major: "EUR",
    is_canonical: false,
  });
  assertEquals(
    pickLine([nms, ger, ams], pos({ currency: "EUR", listingExchange: "IBIS" }), "GER")
      ?.yahoo_symbol,
    "MSF.DE",
  );
  assertEquals(
    pickLine([nms, ams, ger], pos({ currency: "EUR", listingExchange: null }), null)?.yahoo_symbol,
    "MSF.DE",
  );
  assertEquals(pickLine([nms, ger], pos({ currency: "USD" }), null)?.yahoo_symbol, "MSFT");
  assertEquals(pickLine([], pos(), null), null);
});

Deno.test("step 1: ISIN match picks the held line (IBIS in EUR) and signals through the canonical listing", async () => {
  const nms = sec({ id: "1", yahoo_symbol: "MSFT", company_id: "co", isin: "US5949181045" });
  const ger = sec({
    id: "2",
    yahoo_symbol: "MSF.DE",
    exchange_code: "GER",
    currency_major: "EUR",
    is_canonical: false,
    company_id: "co",
    isin: "US5949181045",
  });
  const { p } = ports({
    byIsin: { US5949181045: [nms, ger] },
    exchanges: { IBIS: IBIS },
    canonical: { co: nms },
  });
  const out = await matchPosition(
    pos({ isin: "US5949181045", symbol: "MSF", listingExchange: "IBIS", currency: "EUR" }),
    p,
  );
  assertEquals(out, {
    positionId: 1,
    securityId: "2",
    signalSecurityId: "1",
    matchStatus: "matched_isin",
    reason: null,
  });
});

Deno.test("step 2: unknown ISIN searches Yahoo, stores the ISIN on the security and matches", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL", company_id: "co9" });
  const { p, calls } = ports({
    search: { US0378331005: [{ symbol: "AAPL", quoteType: "EQUITY" }] },
    bySymbol: { AAPL: aapl },
  });
  const out = await matchPosition(pos(), p);
  assertEquals(out.matchStatus, "matched_isin");
  assertEquals(out.securityId, "9");
  assertEquals(out.signalSecurityId, "9");
  assertEquals(calls.isinSet, [["9", "US0378331005"]]);
});

Deno.test("step 2: a symbol unknown to the database is created when the exchange exists, otherwise the reason is reported", async () => {
  const created = sec({ id: "n1", yahoo_symbol: "NEWCO" });
  const hit = { US1111111111: [{ symbol: "NEWCO", quoteType: "EQUITY" }] };
  const a = ports({ search: hit, ensure: { NEWCO: created } });
  assertEquals(
    (await matchPosition(pos({ isin: "US1111111111", symbol: "NEWCO" }), a.p)).securityId,
    "n1",
  );
  assertEquals(a.calls.ensured, ["NEWCO"]);
  const b = ports({ search: hit, ensure: { NEWCO: { error: "unknown_exchange" } }, exchanges: {} });
  const out = await matchPosition(
    pos({ isin: "US1111111111", symbol: "NEWCO", listingExchange: null }),
    b.p,
  );
  assertEquals(out, {
    positionId: 1,
    securityId: null,
    signalSecurityId: null,
    matchStatus: "unmatched",
    reason: "unknown_exchange",
  });
});

Deno.test("step 3: without an ISIN, symbol plus listing exchange (NASDAQ no suffix, IBIS .DE)", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL" });
  const sap = sec({ id: "8", yahoo_symbol: "SAP.DE", exchange_code: "GER", currency_major: "EUR" });
  const { p } = ports({
    bySymbol: { AAPL: aapl, "SAP.DE": sap },
    exchanges: { NASDAQ: NASDAQ, IBIS: IBIS },
  });
  assertEquals(
    (await matchPosition(pos({ isin: null }), p)).matchStatus,
    "matched_symbol_exchange",
  );
  const out = await matchPosition(
    pos({ isin: null, symbol: "SAP", listingExchange: "IBIS", currency: "EUR" }),
    p,
  );
  assertEquals([out.securityId, out.matchStatus], ["8", "matched_symbol_exchange"]);
});

Deno.test("never guesses: no ISIN and an unknown listing exchange, or no ISIN and no listing exchange, stay unmatched", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL" });
  const { p } = ports({ bySymbol: { AAPL: aapl }, exchanges: { NASDAQ: NASDAQ } });
  for (const listingExchange of ["MYSTERY", null]) {
    const out = await matchPosition(pos({ isin: null, listingExchange }), p);
    assertEquals([out.securityId, out.matchStatus, out.reason], [null, "unmatched", "no_match"]);
  }
});

Deno.test("ETFs and funds are matched for valuation but are not equities; other asset classes are not matched at all", async () => {
  const etf = sec({
    id: "e",
    yahoo_symbol: "VWCE.DE",
    quote_type: "ETF",
    exchange_code: "GER",
    currency_major: "EUR",
  });
  const { p } = ports({ byIsin: { IE00BK5BQT80: [etf] }, exchanges: { IBIS: IBIS } });
  const out = await matchPosition(
    pos({
      isin: "IE00BK5BQT80",
      symbol: "VWCE",
      listingExchange: "IBIS",
      currency: "EUR",
      subCategory: "ETF",
    }),
    p,
  );
  assertEquals(
    [out.securityId, out.signalSecurityId, out.matchStatus, out.reason],
    ["e", null, "not_equity", "not_an_equity"],
  );
  const option = await matchPosition(pos({ assetClass: "OPT" }), p);
  assertEquals([option.securityId, option.matchStatus], [null, "not_equity"]);
});

Deno.test("matchUserPositions applies every outcome and counts them (bounded per call)", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL" });
  const { p } = ports({ byIsin: { US0378331005: [aapl] } });
  const applied: Array<{ positionId: number; matchStatus: string }> = [];
  const store = {
    positionsToMatch: () =>
      Promise.resolve([
        pos({ id: 1 }),
        pos({ id: 2, isin: null, listingExchange: null, symbol: "ZZZ" }),
        pos({ id: 3, assetClass: "BOND" }),
      ]),
    applyOutcome: (_user: string, o: { positionId: number; matchStatus: string }) => (
      applied.push(o), Promise.resolve()
    ),
  };
  assertEquals(await matchUserPositions("u", store, p), { matched: 1, unmatched: 1, notEquity: 1 });
  assertEquals(
    applied.map((a) => [a.positionId, a.matchStatus]),
    [
      [1, "matched_isin"],
      [2, "unmatched"],
      [3, "not_equity"],
    ],
  );
  assertEquals(
    (
      await matchUserPositions(
        "u",
        {
          ...store,
          positionsToMatch: () =>
            Promise.resolve(Array.from({ length: 50 }, (_, i) => pos({ id: i + 1 }))),
        },
        p,
        30,
      )
    ).matched,
    30,
  );
});

Deno.test("the ISIN fallback only accepts a Yahoo hit that agrees on currency and listing exchange", async () => {
  const hit = { US0378331005: [{ symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS" }] };
  const eur = sec({ id: "9", yahoo_symbol: "AAPL", currency_major: "EUR", exchange_code: "NMS" });
  const a = ports({ search: hit, bySymbol: { AAPL: eur } });
  const out = await matchPosition(pos(), a.p);
  assertEquals(
    [out.securityId, out.matchStatus, out.reason],
    [null, "unmatched", "listing_mismatch"],
  );
  assertEquals(a.calls.isinSet, []);
  const b = ports({
    search: { US0378331005: [{ symbol: "AAPL.DE", quoteType: "EQUITY", exchange: "GER" }] },
    exchanges: { NASDAQ: NASDAQ },
    bySymbol: { "AAPL.DE": sec({ id: "8", yahoo_symbol: "AAPL.DE", exchange_code: "GER" }) },
  });
  assertEquals((await matchPosition(pos(), b.p)).matchStatus, "unmatched");
  assertEquals(b.calls.ensured, []);
});

Deno.test("orderForMatching puts untried positions first and rotates persistent misses", () => {
  const rows = [3, 1, 2, 5, 4].map((id) => ({ id, attempted: id <= 3 }));
  assertEquals(
    orderForMatching(rows, 0).map((r) => r.id),
    [4, 5, 1, 2, 3],
  );
  assertEquals(
    orderForMatching(rows, 1).map((r) => r.id),
    [4, 5, 2, 3, 1],
  );
});
