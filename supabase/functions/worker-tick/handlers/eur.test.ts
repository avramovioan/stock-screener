import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFakeClock } from "../../_shared/adapters/clock.ts";
import {
  type CatalogueRow,
  createFixtureCatalogueFetch,
} from "../../_shared/adapters/ibkr-catalogue.ts";
import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { parseCatalogueState, runEurCatalogue, seedEurCatalogue } from "./eur_catalogue.ts";
import {
  assessCandidate,
  baseTicker,
  type CanonicalSecurity,
  type CatalogueCandidate,
  isoWeek,
  matchBasis,
  nameSimilarity,
  priceDeviation,
  probeSymbol,
  rankCandidates,
} from "./eur_match.ts";
import {
  type CatalogueStore,
  type EurEquivalentRow,
  type FxRate,
  type OverrideRow,
  parseEurSettings,
  type ResolveStore,
  resolveEurEquivalent,
  runEurResolve,
  seedEurResolve,
} from "./eur_resolve.ts";

// ------------------------------------------------------------------------------------------------ fixtures and fakes

const NOW = Date.UTC(2026, 9, 15, 7, 30, 0);
const SHARES = 7_425_545_491;

const MSFT: CanonicalSecurity = {
  id: "sec-msft",
  yahooSymbol: "MSFT",
  currency: "USD",
  currencyMajor: "USD",
  minorDivisor: 1,
  longName: "Microsoft Corporation",
  companyName: "Microsoft Corporation",
  sharesOutstanding: SHARES,
  isin: null,
};
const UNILEVER: CanonicalSecurity = {
  id: "sec-ulvr",
  yahooSymbol: "ULVR.L",
  currency: "GBp",
  currencyMajor: "GBP",
  minorDivisor: 100,
  longName: "Unilever PLC",
  companyName: "Unilever PLC",
  sharesOutstanding: 2_480_000_000,
  isin: null,
};

const MSF: CatalogueCandidate = {
  exchange_id: "IBIS",
  conid: 12178239,
  symbol: "MSF",
  local_symbol: "MSF",
  isin: "US5949181045",
  description: "MICROSOFT CORP",
};
const UNA: CatalogueCandidate = {
  exchange_id: "AEB",
  conid: 837455595,
  symbol: "UNVB",
  local_symbol: "UNA",
  isin: "GB00BVZK7T90",
  description: "UNILEVER PLC",
};
// A look-alike on AEB: same ticker as the US stock, but it is the tracker ETP (research: MSFT.AS is "LS 1x Microsoft Tracker ETP Securities").
const MSFT_TRACKER: CatalogueCandidate = {
  exchange_id: "AEB",
  conid: 900000010,
  symbol: "MSFT",
  local_symbol: "MSFT",
  isin: "XS0000000010",
  description: "LS 1X MICROSOFT TRACKER ETP",
};

const quote = (symbol: string, over: Partial<QuoteRecord> = {}): QuoteRecord => ({
  symbol,
  quoteType: "EQUITY",
  currency: "EUR",
  financialCurrency: null,
  exchange: "GER",
  fullExchangeName: "XETRA",
  longName: "Microsoft Corporation",
  shortName: null,
  marketCap: null,
  sharesOutstanding: SHARES,
  regularMarketPrice: 472.85,
  regularMarketTime: NOW,
  regularMarketPreviousClose: null,
  regularMarketChangePercent: null,
  marketState: "CLOSED",
  firstTradeDateMs: null,
  exchangeTimezoneName: null,
  priceHint: null,
  ...over,
});
const msftQuote = (over: Partial<QuoteRecord> = {}): QuoteRecord =>
  quote("MSFT", {
    currency: "USD",
    exchange: "NMS",
    fullExchangeName: "NasdaqGS",
    regularMarketPrice: 533.69,
    ...over,
  });

const FX: Record<string, FxRate> = {
  EUR: { usdPerUnit: 1.1213, rateDate: "2026-10-14" },
  USD: { usdPerUnit: 1, rateDate: "2026-10-14" },
  GBP: { usdPerUnit: 1.3, rateDate: "2026-10-14" },
};

function fakeMarket(opts: {
  search?: Record<string, string | null>;
  quotes?: QuoteRecord[];
  failQuote?: Error;
  failSearch?: Error;
}) {
  const calls = { search: [] as string[], quote: [] as string[][] };
  return {
    calls,
    market: {
      search(q: string) {
        calls.search.push(q);
        if (opts.failSearch) return Promise.reject(opts.failSearch);
        const symbol = opts.search?.[q] ?? null;
        return Promise.resolve({
          hits:
            symbol === null
              ? []
              : [
                  {
                    symbol,
                    exchange: "NMS",
                    quoteType: "EQUITY",
                    longName: null,
                    shortName: null,
                    sector: null,
                    industry: null,
                  },
                ],
          news: [],
        });
      },
      quote(symbols: string[]) {
        calls.quote.push(symbols);
        if (opts.failQuote) return Promise.reject(opts.failQuote);
        const wanted = new Set(symbols.map((s) => s.toUpperCase()));
        return Promise.resolve(
          (opts.quotes ?? []).filter((x) => wanted.has(x.symbol.toUpperCase())),
        );
      },
    },
  };
}

function fakeStore(
  opts: {
    candidates?: CatalogueCandidate[];
    overrides?: OverrideRow[];
    held?: string[];
    security?: CanonicalSecurity | null;
    targets?: string[];
    settings?: Record<string, unknown>;
    existing?: EurEquivalentRow[];
  } = {},
) {
  const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
  const log = {
    replaced: [] as { id: string; rows: EurEquivalentRow[] }[],
    isins: [] as [string, string][],
    upserts: [] as CatalogueRow[][],
    findQueries: [] as unknown[],
  };
  const store: ResolveStore & CatalogueStore = {
    getSetting: (k) => Promise.resolve(settings.get(k) ?? null),
    setSetting: (k, v) => {
      settings.set(k, structuredClone(v));
      return Promise.resolve();
    },
    loadSecurity: () => Promise.resolve(opts.security === undefined ? MSFT : opts.security),
    heldIsins: () => Promise.resolve(opts.held ?? []),
    activeOverrides: () => Promise.resolve(opts.overrides ?? []),
    findCandidates: (q) => {
      log.findQueries.push(q);
      return Promise.resolve(opts.candidates ?? []);
    },
    loadFx: (ccys) =>
      Promise.resolve(new Map(ccys.flatMap((c) => (FX[c] ? [[c, FX[c] as FxRate] as const] : [])))),
    replaceEquivalents: (id, rows) => {
      log.replaced.push({ id, rows });
      return Promise.resolve();
    },
    setSecurityIsin: (id, isin) => {
      log.isins.push([id, isin]);
      return Promise.resolve();
    },
    currentEquivalents: () => Promise.resolve(opts.existing ?? []),
    resolveTargets: () => Promise.resolve(opts.targets ?? []),
    upsertCatalogue: (rows) => {
      log.upserts.push(rows);
      return Promise.resolve();
    },
  };
  return { store, settings, log };
}

const resolve = (
  security: CanonicalSecurity,
  m: ReturnType<typeof fakeMarket>,
  s: ReturnType<typeof fakeStore>,
  requireShares = false,
) =>
  resolveEurEquivalent(security, {
    store: s.store,
    market: m.market,
    scanDate: "2026-10-15",
    nowMs: NOW,
    requireShares,
  });

/** The verification document of a stored row, typed for the assertion at hand. */
const verificationOf = <T>(row: EurEquivalentRow | undefined): T => (row?.verification ?? {}) as T;

// ------------------------------------------------------------------------------------------------ pure helpers

Deno.test("nameSimilarity: IBKR descriptions against Yahoo long names", () => {
  assertEquals(nameSimilarity("MICROSOFT CORP", "Microsoft Corporation"), 1);
  assertEquals(nameSimilarity("ASML HOLDING NV", "ASML Holding N.V."), 1);
  assert(nameSimilarity("SAP SE", "SAP SE") === 1);
  assert(
    nameSimilarity("GOOGLE INC.", "Alphabet Inc.") < 0.9,
    "a stale IBKR description must not match; ISIN is what matches those",
  );
  assert(nameSimilarity("LS 1X MICROSOFT TRACKER ETP", "Microsoft Corporation") < 0.9);
  assertEquals(nameSimilarity("", "Microsoft"), 0);
});

Deno.test("baseTicker, probeSymbol and isoWeek", () => {
  assertEquals(
    [baseTicker("MSFT"), baseTicker("SAP.DE"), baseTicker("BRK-B"), baseTicker("ulvr.l")],
    ["MSFT", "SAP", "BRK-B", "ULVR"],
  );
  assertEquals([probeSymbol("IBIS", "MSF"), probeSymbol("AEB", "UNA")], ["MSF.DE", "UNA.AS"]);
  assertEquals(isoWeek("2026-10-15"), "2026-W42");
  assertEquals(isoWeek("2026-10-18"), "2026-W42"); // Sunday
  assertEquals(isoWeek("2026-10-19"), "2026-W43"); // Monday
  assertEquals(isoWeek("2026-01-01"), "2026-W01");
  assertEquals(isoWeek("2027-01-01"), "2026-W53");
  assertEquals(isoWeek("2024-12-30"), "2025-W01");
  assertEquals(isoWeek("2024-02-29"), "2024-W09");
});

Deno.test("priceDeviation: MSF.DE x EURUSD against MSFT is 0.65% apart (spike 3.5); GBp is divided by the minor divisor", () => {
  const fx = { eurUsd: 1.1213, ccyUsd: 1, rateDate: "2026-10-14" };
  const d = priceDeviation({
    eurPrice: 472.85,
    canonicalPrice: 533.69,
    canonicalMinorDivisor: 1,
    canonicalMajor: "USD",
    fx,
  });
  assert(d !== null && Math.abs(d + 0.0065) < 0.0002, `got ${d}`);
  // ULVR.L at 4,500 GBp = 45 GBP = 58.5 USD; EUR price 52.17 x 1.1213 = 58.5 USD
  const u = priceDeviation({
    eurPrice: 52.17,
    canonicalPrice: 4500,
    canonicalMinorDivisor: 100,
    canonicalMajor: "GBP",
    fx: { eurUsd: 1.1213, ccyUsd: 1.3, rateDate: "x" },
  });
  assert(u !== null && Math.abs(u) < 0.001, `got ${u}`);
  assertEquals(
    priceDeviation({
      eurPrice: 100,
      canonicalPrice: 100,
      canonicalMinorDivisor: 1,
      canonicalMajor: "EUR",
      fx: { eurUsd: null, ccyUsd: null, rateDate: null },
    }),
    0,
  );
  assertEquals(
    priceDeviation({
      eurPrice: 100,
      canonicalPrice: 100,
      canonicalMinorDivisor: 1,
      canonicalMajor: "USD",
      fx: { eurUsd: null, ccyUsd: 1, rateDate: null },
    }),
    null,
  );
  assertEquals(
    priceDeviation({
      eurPrice: null,
      canonicalPrice: 100,
      canonicalMinorDivisor: 1,
      canonicalMajor: "USD",
      fx,
    }),
    null,
  );
});

Deno.test("matchBasis: ISIN beats description beats ticker; unrelated rows are dropped", () => {
  assertEquals(matchBasis(MSFT, ["US5949181045"], MSF)?.basis, "isin");
  assertEquals(matchBasis(MSFT, [], MSF)?.basis, "description");
  assertEquals(
    matchBasis(MSFT, [], { ...MSF, symbol: "MSFT", description: "UNRELATED NAME" })?.basis,
    "symbol",
  );
  assertEquals(matchBasis(MSFT, [], { ...MSF, description: "UNRELATED NAME" }), null);
});

Deno.test("rankCandidates: IBIS before AEB, ISIN basis first, at most N per exchange", () => {
  const mk = (
    c: CatalogueCandidate,
    basis: "isin" | "description" | "symbol",
    similarity: number | null = 1,
  ) => ({ candidate: c, match: { basis, similarity } });
  const out = rankCandidates(
    [
      mk(UNA, "isin"),
      mk(MSF, "description"),
      mk({ ...MSF, conid: 1 }, "isin"),
      mk({ ...MSF, conid: 2 }, "isin"),
      mk({ ...MSF, conid: 3 }, "isin"),
    ],
    2,
  );
  assertEquals(
    out.map((r) => r.candidate.conid),
    [1, 2, 837455595],
  );
});

Deno.test("parseEurSettings and parseCatalogueState tolerate garbage", () => {
  assertEquals(parseEurSettings(null), {
    enabled: true,
    requireShares: false,
    maxResolvePerRun: 40,
  });
  assertEquals(parseEurSettings({ enabled: false, require_shares: true, max_resolve_per_run: 5 }), {
    enabled: false,
    requireShares: true,
    maxResolvePerRun: 5,
  });
  assertEquals(parseEurSettings({ enabled: "no", max_resolve_per_run: 9999 }), {
    enabled: true,
    requireShares: false,
    maxResolvePerRun: 40,
  });
  assertEquals(parseCatalogueState("x"), {
    last_success_week: null,
    last_success_at: null,
    last_attempt_day: null,
    last_result: null,
    detail: null,
  });
});

// ------------------------------------------------------------------------------------------------ resolution (spec 5.7)

Deno.test("MSFT resolves to MSF.DE as verified on IBIS, and the confirmed ISIN is stored for later use", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const s = fakeStore({ candidates: [MSF] });
  const out = await resolve(MSFT, m, s);
  assertEquals(out.summary.result, "verified");
  assertEquals(out.rows.length, 1);
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(
    [row.ibkr_exchange_id, row.ibkr_local_symbol, row.ibkr_conid, row.eur_symbol_yahoo, row.status],
    ["IBIS", "MSF", 12178239, "MSF.DE", "verified"],
  );
  assertEquals(row.isin, "US5949181045");
  assertEquals(row.verified_at, "2026-10-15T07:30:00.000Z");
  const v = row.verification as {
    checks: Record<string, string>;
    failed: string[];
    price_deviation_pct: number;
    method: string;
    basis: string;
  };
  assertEquals(v.failed, []);
  assertEquals(v.method, "automatic");
  assertEquals(v.basis, "description"); // the ISIN of MSFT was not known yet; the description (1.0) found the row
  assert(
    Object.values(v.checks).every((c) => c === "pass"),
    JSON.stringify(v.checks),
  );
  assert(Math.abs(v.price_deviation_pct + 0.65) < 0.05);
  assertEquals(out.isin, "US5949181045");
  assertEquals(m.calls.search, ["US5949181045"]);
  assertEquals(m.calls.quote.length, 1, "one quote() call for the canonical line and every probe");
  assertEquals(m.calls.quote[0], ["MSFT", "MSF.DE"]);
});

Deno.test("a known ISIN (from Flex) finds the row even when the catalogue description is stale", async () => {
  const stale: CatalogueCandidate = {
    exchange_id: "IBIS",
    conid: 208914695,
    symbol: "ABEC",
    local_symbol: "ABEC",
    isin: "US02079K1079",
    description: "GOOGLE INC.",
  };
  const alphabet: CanonicalSecurity = {
    ...MSFT,
    id: "sec-goog",
    yahooSymbol: "GOOG",
    longName: "Alphabet Inc.",
    companyName: "Alphabet Inc.",
  };
  const m = fakeMarket({
    search: { US02079K1079: "GOOG" },
    quotes: [
      msftQuote({ symbol: "GOOG", longName: "Alphabet Inc.", regularMarketPrice: 200 }),
      quote("ABEC.DE", { longName: "Alphabet Inc.", regularMarketPrice: 178.4 }),
    ],
  });
  const s = fakeStore({ candidates: [stale], held: ["US02079K1079"] });
  const out = await resolve(alphabet, m, s);
  assertEquals(out.summary.result, "verified");
  assertEquals(verificationOf<{ basis: string }>(out.rows[0]).basis, "isin");
});

Deno.test("the MSFT.AS look-alike (tracker ETP) is rejected and never becomes the EUR equivalent", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT", XS0000000010: "MSFT.AS" },
    quotes: [
      msftQuote(),
      quote("MSF.DE"),
      quote("MSFT.AS", {
        quoteType: "ETF",
        longName: "LS 1x Microsoft Tracker ETP Securities",
        sharesOutstanding: null,
        regularMarketPrice: 9.664,
      }),
    ],
  });
  const s = fakeStore({ candidates: [MSF, MSFT_TRACKER] });
  const out = await resolve(MSFT, m, s);
  assertEquals(out.summary, {
    result: "verified",
    candidates: 2,
    verified: 1,
    unverified: 0,
    rejected: 1,
    overrides: 0,
  });
  assertEquals(
    out.rows.map((r) => r.ibkr_exchange_id),
    ["IBIS"],
    "no AEB row is stored for the look-alike",
  );
  assert(out.rows.every((r) => r.eur_symbol_yahoo !== "MSFT.AS"));
});

Deno.test("the look-alike alone yields none, with the hard failures recorded, never unverified", async () => {
  const m = fakeMarket({
    search: { XS0000000010: "MSFT.AS" },
    quotes: [
      msftQuote(),
      quote("MSFT.AS", {
        quoteType: "ETF",
        longName: "LS 1x Microsoft Tracker ETP Securities",
        regularMarketPrice: 9.664,
      }),
    ],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSFT_TRACKER] }));
  assertEquals(out.summary.result, "none");
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals([row.status, row.ibkr_local_symbol, row.eur_symbol_yahoo], ["none", null, null]);
  const v = row.verification as { reason: string; rejected: { hard_failed: string[] }[] };
  assertEquals(v.reason, "all_candidates_rejected");
  assertEquals(v.rejected[0]?.hard_failed.sort(), [
    "isin_confirmed",
    "name_match",
    "quote_type_equity",
  ]);
});

Deno.test("a price 3% off is unverified with the reason recorded", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote({ regularMarketPrice: 549.7 }), quote("MSF.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF] }));
  assertEquals(out.summary.result, "unverified");
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(row.status, "unverified");
  assertEquals(row.verified_at, null);
  assertEquals(
    row.eur_symbol_yahoo,
    "MSF.DE",
    "the Yahoo line exists, so the unverified row still names it",
  );
  const v = row.verification as {
    failed: string[];
    hard_failed: string[];
    price_deviation_pct: number;
  };
  assertEquals(v.failed, ["price_within_tolerance"]);
  assertEquals(v.hard_failed, []);
  assert(v.price_deviation_pct < -3 && v.price_deviation_pct > -4, `got ${v.price_deviation_pct}`);
  assertEquals(out.isin, null, "an unverified match never writes securities.isin");
});

Deno.test("0.99% off is verified, 1.1% off is not", async () => {
  // implied = 472.85 x 1.1213 = 530.2; canonical = implied / 0.9901 -> deviation -0.99%
  const edge = (472.85 * 1.1213) / 0.9901;
  const ok = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote({ regularMarketPrice: edge }), quote("MSF.DE")],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(ok.summary.result, "verified");
  const off = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote({ regularMarketPrice: (472.85 * 1.1213) / 0.989 }), quote("MSF.DE")],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(off.summary.result, "unverified");
});

Deno.test("no catalogue candidate gives none with the reason, written in the IBIS slot", async () => {
  const m = fakeMarket({ quotes: [msftQuote()] });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [] }));
  assertEquals(out.summary.result, "none");
  assertEquals(out.rows.length, 1);
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals([row.ibkr_exchange_id, row.status, row.ibkr_conid], ["IBIS", "none", null]);
  assertEquals((row.verification as { reason: string }).reason, "no_catalogue_candidate");
  assertEquals(m.calls.quote.length, 0, "no candidate means no Yahoo traffic at all");
  assertEquals(m.calls.search.length, 0);
});

Deno.test("an ISIN that Yahoo ties to another primary listing rejects the candidate", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT.MX" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF] }));
  assertEquals(out.summary.result, "none");
  assertEquals(out.summary.rejected, 1);
});

Deno.test("search without a hit or without Yahoo line leaves the candidate unverified (missing data), not rejected", async () => {
  const noHit = await resolve(
    MSFT,
    fakeMarket({ search: {}, quotes: [msftQuote(), quote("MSF.DE")] }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(noHit.summary.result, "unverified");
  assertEquals(verificationOf<{ failed: string[] }>(noHit.rows[0]).failed, ["isin_confirmed"]);
  const noLine = await resolve(
    MSFT,
    fakeMarket({ search: { US5949181045: "MSFT" }, quotes: [msftQuote()] }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(noLine.summary.result, "unverified");
  assertEquals(noLine.rows[0]?.eur_symbol_yahoo, null);
  const failed = verificationOf<{ failed: string[] }>(noLine.rows[0]).failed;
  assert(
    ["currency_eur", "quote_type_equity", "name_match", "price_within_tolerance"].every((n) =>
      failed.includes(n),
    ),
  );
});

Deno.test("shares outstanding: different counts reject; missing counts pass unless require_shares is on", async () => {
  const different = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { sharesOutstanding: SHARES + 1 })],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(different.summary.result, "none");
  const missing = (): ReturnType<typeof fakeMarket> =>
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { sharesOutstanding: null })],
    });
  const lenient = await resolve(MSFT, missing(), fakeStore({ candidates: [MSF] }));
  assertEquals(lenient.summary.result, "verified");
  assertEquals(
    verificationOf<{ checks: Record<string, string> }>(lenient.rows[0]).checks[
      "shares_outstanding"
    ],
    "not_available",
  );
  const strict = await resolve(MSFT, missing(), fakeStore({ candidates: [MSF] }), true);
  assertEquals(strict.summary.result, "unverified");
  assertEquals(verificationOf<{ failed: string[] }>(strict.rows[0]).failed, ["shares_outstanding"]);
});

Deno.test("a non-EUR Yahoo line is rejected", async () => {
  const out = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { currency: "MXN" })],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(out.summary.result, "none");
});

Deno.test("Unilever: the probe uses the IBKR localSymbol UNA (not the symbol UNVB) and the GBp price is converted", async () => {
  const ulvr = msftQuote({
    symbol: "ULVR.L",
    currency: "GBp",
    longName: "Unilever PLC",
    sharesOutstanding: 2_480_000_000,
    regularMarketPrice: 4500,
  });
  const una = quote("UNA.AS", {
    longName: "Unilever PLC",
    sharesOutstanding: 2_480_000_000,
    regularMarketPrice: 52.17,
    exchange: "AMS",
  });
  const m = fakeMarket({ search: { GB00BVZK7T90: "ULVR.L" }, quotes: [ulvr, una] });
  const out = await resolve(UNILEVER, m, fakeStore({ candidates: [UNA] }));
  assertEquals(m.calls.quote[0], ["ULVR.L", "UNA.AS"]);
  assert(!m.calls.quote[0]?.some((s) => s.startsWith("UNVB")));
  assertEquals(out.summary.result, "verified");
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(
    [row.ibkr_exchange_id, row.ibkr_local_symbol, row.eur_symbol_yahoo],
    ["AEB", "UNA", "UNA.AS"],
  );
});

Deno.test("both exchanges: each gets its own row, IBIS first; an unverified AEB row does not hide a verified IBIS row", async () => {
  const aeb: CatalogueCandidate = {
    exchange_id: "AEB",
    conid: 5,
    symbol: "MSF",
    local_symbol: "MSF",
    isin: "US5949181045",
    description: "MICROSOFT CORP",
  };
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE"), quote("MSF.AS", { regularMarketPrice: 400 })],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [aeb, MSF] }));
  assertEquals(
    out.rows.map((r) => [r.ibkr_exchange_id, r.status]),
    [
      ["IBIS", "verified"],
      ["AEB", "unverified"],
    ],
  );
  assertEquals(m.calls.search, ["US5949181045"], "one search per distinct ISIN");
});

Deno.test("an invalid local symbol cannot be verified (the prompt could not be built from it)", async () => {
  const lower: CatalogueCandidate = { ...MSF, local_symbol: "MSFd" };
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSFD.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [lower] }));
  assertEquals(out.summary.result, "unverified");
  assert(verificationOf<{ failed: string[] }>(out.rows[0]).failed.includes("local_symbol_format"));

  // a catalogue row whose "local symbol" is really a Yahoo ticker (MSF.DE) is never verified either
  const yahooLike: CatalogueCandidate = { ...MSF, local_symbol: "MSF.DE" };
  const m2 = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE.DE")],
  });
  const out2 = await resolve(MSFT, m2, fakeStore({ candidates: [yahooLike] }));
  assertEquals(out2.summary.result, "unverified");
  assert(verificationOf<{ failed: string[] }>(out2.rows[0]).failed.includes("local_symbol_format"));
});

Deno.test("an override row wins: force writes a manual verified row without any Yahoo traffic for that exchange", async () => {
  const force: OverrideRow = {
    id: "ovr-1",
    ibkr_exchange_id: "IBIS",
    action: "force",
    ibkr_conid: 12178239,
    ibkr_local_symbol: "MSF",
    eur_symbol_yahoo: "MSF.DE",
    isin: "US5949181045",
    reason: "checked on the IBKR ticket 2026-10-15",
  };
  const m = fakeMarket({ quotes: [msftQuote()] });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF], overrides: [force] }));
  assertEquals(out.rows.length, 1);
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(
    [row.status, row.ibkr_local_symbol, row.eur_symbol_yahoo],
    ["verified", "MSF", "MSF.DE"],
  );
  assertEquals(
    (row.verification as { method: string; override_id: string }).method,
    "manual_override",
  );
  assertEquals((row.verification as { override?: boolean }).override, true);
  assertEquals(m.calls.quote.length + m.calls.search.length, 0);
});

Deno.test("an override block removes the exchange; blocking the only candidate yields none (blocked_by_override)", async () => {
  const block: OverrideRow = {
    id: "ovr-2",
    ibkr_exchange_id: "IBIS",
    action: "block",
    ibkr_conid: null,
    ibkr_local_symbol: null,
    eur_symbol_yahoo: null,
    isin: null,
    reason: "wrong instrument on the ticket",
  };
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF], overrides: [block] }));
  assertEquals(out.summary.result, "none");
  assertEquals(verificationOf<{ reason: string }>(out.rows[0]).reason, "blocked_by_override");
});

Deno.test("a failing Yahoo quote leaves the candidate unverified; an open breaker propagates so the job is deferred", async () => {
  const soft = await resolve(
    MSFT,
    fakeMarket({ search: { US5949181045: "MSFT" }, failQuote: new Error("boom") }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(soft.summary.result, "unverified");
  const breaker = Object.assign(new Error("open"), { name: "YahooUnavailableError" });
  await assertRejects(
    () => resolve(MSFT, fakeMarket({ failSearch: breaker }), fakeStore({ candidates: [MSF] })),
    Error,
    "open",
  );
  await assertRejects(
    () =>
      resolve(
        MSFT,
        fakeMarket({ search: { US5949181045: "MSFT" }, failQuote: breaker }),
        fakeStore({ candidates: [MSF] }),
      ),
    Error,
    "open",
  );
});

Deno.test("assessCandidate never reports verified when the ISIN could not be confirmed", () => {
  const a = assessCandidate({
    security: MSFT,
    securityQuote: msftQuote(),
    candidate: MSF,
    match: { basis: "description", similarity: 1 },
    knownIsins: [],
    isinSearch: "unavailable",
    probe: quote("MSF.DE"),
    fx: { eurUsd: 1.1213, ccyUsd: 1, rateDate: "2026-10-14" },
    requireShares: false,
    nowMs: NOW,
  });
  assertEquals(a.outcome, "unverified");
  assertEquals(a.verification.checks.isin_confirmed, "not_available");
});

// ------------------------------------------------------------------------------------------------ handlers

const resolveCtx = (key: string) => ({
  job: { key },
  run: { scanDateLocal: "2026-10-15", startedAtMs: NOW },
  signal: new AbortController().signal,
  events: [] as { event: string; data?: Record<string, unknown> }[],
});
function ctxWithLog(key: string) {
  const c = resolveCtx(key);
  return {
    ...c,
    log: (event: string, data?: Record<string, unknown>) => {
      c.events.push(data === undefined ? { event } : { event, data });
      return Promise.resolve();
    },
  };
}

Deno.test("runEurResolve: replaces the rows, stores the confirmed ISIN, logs one event without any user data", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const s = fakeStore({ candidates: [MSF] });
  const ctx = ctxWithLog("eur:sec-msft");
  const result = await runEurResolve(ctx, { store: s.store, market: m.market });
  assertEquals(result["status"], "resolved");
  assertEquals(s.log.replaced.length, 1);
  assertEquals(s.log.replaced[0]?.id, "sec-msft");
  assertEquals(s.log.isins, [["sec-msft", "US5949181045"]]);
  assertEquals(
    ctx.events.map((e) => e.event),
    ["eur_resolved"],
  );
  assertEquals(ctx.events[0]?.data?.["exchanges"], ["IBIS:verified"]);
});

Deno.test("runEurResolve: unknown key, missing security and require_shares from settings", async () => {
  const noop = await runEurResolve(ctxWithLog("other:1"), {
    store: fakeStore().store,
    market: fakeMarket({}).market,
  });
  assertEquals(noop, { status: "noop" });
  const gone = await runEurResolve(ctxWithLog("eur:zzz"), {
    store: fakeStore({ security: null }).store,
    market: fakeMarket({}).market,
  });
  assertEquals(gone, { status: "skipped", reason: "security_not_found" });
  const strict = fakeStore({
    candidates: [MSF],
    settings: { eur_catalogue: { require_shares: true } },
  });
  const r = await runEurResolve(ctxWithLog("eur:sec-msft"), {
    store: strict.store,
    market: fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { sharesOutstanding: null })],
    }).market,
  });
  assertEquals(r["result"], "unverified");
});

Deno.test("seedEurResolve: one job per target, capped by max_resolve_per_run; an empty plan when nothing is due", async () => {
  const none = await seedEurResolve({ run: { id: "run-1" } as never }, fakeStore().store);
  assertEquals(none, { keys: [] });
  const some = await seedEurResolve(
    { run: { id: "run-1" } as never },
    fakeStore({ targets: ["a", "b"] }).store,
  );
  assertEquals(some.keys, ["eur:a", "eur:b"]);
  assertEquals(some.payloads, [{ securityId: "a" }, { securityId: "b" }]);
});

// ---- catalogue import

const fixture = async (name: string): Promise<{ products: unknown[] }> =>
  JSON.parse(
    await Deno.readTextFile(new URL(`../../_shared/adapters/fixtures/${name}`, import.meta.url)),
  );

async function catalogueHarness(
  over: { settings?: Record<string, unknown>; fetchImpl?: (n: number) => Response } = {},
) {
  const ibis = await fixture("ibkr-catalogue-ibis-page1.json");
  const aeb = await fixture("ibkr-catalogue-aeb-page1.json");
  const fixtureFetch = createFixtureCatalogueFetch({ IBIS: [ibis.products], AEB: [aeb.products] });
  const clock = createFakeClock();
  let requests = 0;
  const fetchImpl = (url: string, init?: RequestInit) => {
    requests += 1;
    return over.fetchImpl ? Promise.resolve(over.fetchImpl(requests)) : fixtureFetch(url, init);
  };
  const s = fakeStore({ settings: over.settings ?? {} });
  const events: { event: string; level?: string }[] = [];
  const ctx = (day: string) => ({
    run: { scanDateLocal: day },
    signal: new AbortController().signal,
    log: (event: string, _d?: Record<string, unknown>, extra?: { level?: string }) => {
      events.push(extra?.level === undefined ? { event } : { event, level: extra.level });
      return Promise.resolve();
    },
  });
  return {
    s,
    clock,
    ctx,
    events,
    requests: () => requests,
    deps: { store: s.store, fetchImpl, clock },
  };
}

Deno.test("catalogue import: both exchanges are read and written, the week is recorded, one info event", async () => {
  const h = await catalogueHarness();
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r["status"], "imported");
  assertEquals(
    h.s.log.upserts
      .flat()
      .map((x) => `${x.exchange_id}:${x.local_symbol}`)
      .sort(),
    ["AEB:ADYEN", "AEB:ASML", "AEB:UNA", "IBIS:APC", "IBIS:MSF", "IBIS:SAP"],
  );
  assertEquals(h.requests(), 2);
  const state = parseCatalogueState(h.s.settings.get("eur_catalogue_state"));
  assertEquals(
    [state.last_success_week, state.last_result, state.last_attempt_day],
    ["2026-W42", "complete", "2026-10-15"],
  );
  assertEquals(
    h.events.map((e) => e.event),
    ["eur_catalogue_imported"],
  );
  assertEquals(seedEurCatalogue({ run: { scanDateLocal: "2026-10-15" } }).keys, [
    "eur_catalogue:2026-W42",
  ]);
});

Deno.test("catalogue import: a second run in the same ISO week does nothing and makes no request", async () => {
  const h = await catalogueHarness();
  await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  const before = h.requests();
  const again = await runEurCatalogue(h.ctx("2026-10-17"), h.deps);
  assertEquals(again, {
    status: "skipped",
    reason: "already_imported_this_week",
    week: "2026-W42",
  });
  assertEquals(h.requests(), before);
  const nextWeek = await runEurCatalogue(h.ctx("2026-10-19"), h.deps);
  assertEquals(nextWeek["status"], "imported");
});

Deno.test("catalogue import: app_settings.eur_catalogue.enabled = false switches it off", async () => {
  const h = await catalogueHarness({ settings: { eur_catalogue: { enabled: false } } });
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r, { status: "skipped", reason: "disabled" });
  assertEquals(h.requests(), 0);
});

Deno.test("catalogue import: a failing endpoint is abandoned for the day, never retried that day, and tried again the next day", async () => {
  const h = await catalogueHarness({ fetchImpl: () => new Response("boom", { status: 500 }) });
  const first = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(first["status"], "aborted");
  assertEquals(h.requests(), 4, "one request plus three retries, then stop");
  assertEquals(h.s.log.upserts.length, 0);
  assertEquals(
    (first["abort"] as { exchange: string; reason: string; status: number }).reason,
    "http_error",
  );
  assertEquals(
    h.events.map((e) => [e.event, e.level]),
    [["eur_catalogue_aborted", "warn"]],
  );

  const sameDay = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(sameDay["reason"], "already_attempted_today");
  assertEquals(h.requests(), 4, "the same day makes no further request");

  const nextDay = await runEurCatalogue(h.ctx("2026-10-16"), h.deps);
  assertEquals(nextDay["status"], "aborted");
  assertEquals(h.requests(), 8, "the next day gets one more bounded attempt");
});

Deno.test("catalogue import: if AEB fails after IBIS succeeded, IBIS rows are kept, AEB is untouched, the import is not marked successful", async () => {
  const ibis = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = await catalogueHarness({
    fetchImpl: (n) =>
      n === 1
        ? new Response(JSON.stringify({ products: ibis.products, productCount: 5 }), {
            status: 200,
          })
        : new Response("x", { status: 503 }),
  });
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r["status"], "aborted");
  assertEquals(
    h.s.log.upserts.flat().map((x) => x.exchange_id),
    ["IBIS", "IBIS", "IBIS"],
  );
  const state = parseCatalogueState(h.s.settings.get("eur_catalogue_state"));
  assertEquals([state.last_success_week, state.last_result], [null, "aborted"]);
});

Deno.test("catalogue import: a database error is recorded as data, not thrown (the scan must not degrade)", async () => {
  const h = await catalogueHarness();
  h.s.store.upsertCatalogue = () => Promise.reject(new Error("db down"));
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r["status"], "error");
  assertEquals(parseCatalogueState(h.s.settings.get("eur_catalogue_state")).last_result, "error");
});

Deno.test("catalogue import: an aborted job signal is rethrown", async () => {
  const h = await catalogueHarness();
  const ctl = new AbortController();
  ctl.abort();
  await assertRejects(() =>
    runEurCatalogue({ ...h.ctx("2026-10-15"), signal: ctl.signal }, h.deps),
  );
});

Deno.test("runEurResolve: a failed Yahoo quote call keeps the previously verified row instead of degrading it", async () => {
  const verified: EurEquivalentRow = {
    ibkr_exchange_id: "IBIS",
    ibkr_conid: 123,
    ibkr_local_symbol: "MSF",
    isin: "US5949181045",
    eur_symbol_yahoo: "MSF.DE",
    status: "verified",
    verification: { checks: "all" },
    verified_at: "2026-10-01T00:00:00.000Z",
  };
  const m = fakeMarket({ search: { US5949181045: "MSFT" }, failQuote: new Error("boom") });
  const s = fakeStore({ candidates: [MSF], existing: [verified] });
  await runEurResolve(ctxWithLog("eur:sec-msft"), { store: s.store, market: m.market });
  assertEquals(s.log.replaced[0]?.rows, [verified]);
});
