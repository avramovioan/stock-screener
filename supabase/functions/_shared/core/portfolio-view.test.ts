import { describe, expect, it } from "vitest";
import type { FxRate, Money } from "./accounting.ts";
import {
  buildPortfolioView,
  type HeldPosition,
  neededFxPairs,
  type QuoteInfo,
  selectLatestSnapshot,
} from "./portfolio-view.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

const pos = (o: Partial<HeldPosition> = {}): HeldPosition => ({
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
  ...o,
});

const quote = (o: Partial<QuoteInfo> = {}): QuoteInfo => ({
  symbol: "AAPL",
  price: 232,
  currency: "USD",
  changePercent: 1,
  regularMarketTime: NOW - 60_000,
  marketState: "REGULAR",
  fetchedAtMs: NOW - 30_000,
  ...o,
});

const yahoo = (rate: number): FxRate => ({ rate, rateDate: "2026-10-15", source: "yahoo" });
const input = (
  positions: HeldPosition[],
  quotes: QuoteInfo[],
  fx: Record<string, FxRate> = {},
  base = "EUR",
) => ({
  nowMs: NOW,
  baseCurrency: base,
  reportDate: "2026-10-14",
  lastStatementDate: "2026-10-14",
  positions,
  quotes: new Map(quotes.map((q) => [q.symbol, q])),
  fx: new Map(Object.entries(fx)),
});

const v = (m: Money): number => {
  if (m.kind !== "ok") throw new Error(`unavailable: ${m.reason}`);
  return m.value;
};

describe("valuation with a delayed quote", () => {
  const view = buildPortfolioView(input([pos()], [quote()], { "USD>EUR": yahoo(0.93) }));
  const row = view.positions[0];

  it("values, independent unrealized P&L (value minus cost), average cost and estimated daily P&L", () => {
    expect(row?.price).toMatchObject({
      value: 232,
      ccy: "USD",
      source: { kind: "delayed_quote", marketState: "REGULAR" },
    });
    expect(v(row?.marketValue as Money)).toBe(2320);
    expect(v(row?.unrealizedIndependent as Money)).toBeCloseTo(318.3, 10);
    expect(row?.averageCost).toBeCloseTo(200.17, 10);
    expect(v(row?.dailyPnl as Money)).toBeCloseTo(10 * (232 - 232 / 1.01), 8);
    expect(row?.unrealizedBroker).toBe(298.3);
    expect(row?.reconciles).toBe(true);
    expect(row?.quoteTime).toBe(new Date(NOW - 60_000).toISOString());
  });

  it("converts to the base currency with the current Yahoo rate and says so", () => {
    expect(row?.fxSource).toBe("yahoo");
    expect(row?.fxDate).toBe("2026-10-15");
    expect(v(row?.valueBase as Money)).toBeCloseTo(2320 * 0.93, 8);
    expect(v(row?.costBase as Money)).toBeCloseTo(2001.7 * 0.93, 8);
  });

  it("the summary uses one rate per position, so total value minus total cost equals total unrealized", () => {
    const t = view.totals;
    expect(v(t.valueBase) - v(t.costBase)).toBeCloseTo(v(t.unrealizedBase), 8);
    expect(t.excluded).toEqual([]);
    expect(view.quotesFetchedAt).toBe(new Date(NOW - 30_000).toISOString());
  });
});

describe("GBp positions are never valued as GBP (pence vs pounds)", () => {
  const shel = pos({
    id: 2,
    conid: 100002,
    symbol: "SHEL",
    currency: "GBP",
    quantity: 100,
    costBasisMoney: 2500,
    costBasisPrice: 25,
    markPrice: 27.35,
    fifoPnlUnrealized: 235,
    fxRateToBase: 1.15,
    valuationSymbol: "SHEL.L",
  });

  it("a Yahoo price in GBp is divided by 100 before use", () => {
    const row = buildPortfolioView(
      input(
        [shel],
        [quote({ symbol: "SHEL.L", price: 2735, currency: "GBp", changePercent: null })],
        { "GBP>EUR": yahoo(1.16) },
      ),
    ).positions[0];
    expect(row?.price.value).toBeCloseTo(27.35, 10);
    expect(row?.price.ccy).toBe("GBP");
    expect(row?.price.note).toMatch(/GBp/);
    expect(v(row?.marketValue as Money)).toBeCloseTo(2735, 8);
    expect(v(row?.unrealizedIndependent as Money)).toBeCloseTo(235, 8);
  });

  it("a price that is 100 times the statement close is rejected and the statement close is used with the reason", () => {
    const row = buildPortfolioView(
      input([shel], [quote({ symbol: "SHEL.L", price: 2735, currency: "GBP" })]),
    ).positions[0];
    expect(row?.price.source).toMatchObject({ kind: "statement_close", reportDate: "2026-10-14" });
    expect((row?.price.source as { reason: string } | undefined)?.reason).toMatch(/unit/i);
    expect(v(row?.marketValue as Money)).toBeCloseTo(2735, 8);
  });

  it("a quote in another currency than the position is converted, or rejected without a rate", () => {
    const eur = quote({ symbol: "AAPL", price: 200, currency: "EUR" });
    const withFx = buildPortfolioView(
      input([pos()], [eur], { "EUR>USD": yahoo(1.1), "USD>EUR": yahoo(0.91) }),
    ).positions[0];
    expect(withFx?.price.value).toBeCloseTo(220, 8);
    expect(withFx?.price.note).toMatch(/EUR/);
    const without = buildPortfolioView(input([pos()], [eur], { "USD>EUR": yahoo(0.91) }))
      .positions[0];
    expect(without?.price.source.kind).toBe("statement_close");
  });
});

describe("no delayed quote", () => {
  it("falls back to the statement close, labelled, and has no daily P&L", () => {
    const row = buildPortfolioView(input([pos()], [], { "USD>EUR": yahoo(0.93) })).positions[0];
    expect(row?.price.source).toMatchObject({
      kind: "statement_close",
      reportDate: "2026-10-14",
      reason: "no delayed quote",
    });
    expect(v(row?.marketValue as Money)).toBe(2300);
    expect(row?.dailyPnl.kind).toBe("unavailable");
    expect(row?.quoteTime).toBeNull();
  });

  it("no quote and no statement mark price is unavailable, never zero", () => {
    const row = buildPortfolioView(input([pos({ markPrice: null })], [])).positions[0];
    expect(row?.price.value).toBeNull();
    expect(row?.marketValue.kind).toBe("unavailable");
    expect(row?.unrealizedIndependent.kind).toBe("unavailable");
  });
});

describe("currency conversion fallbacks", () => {
  it("without a Yahoo rate the Flex rate of the report date is used and labelled flex", () => {
    const row = buildPortfolioView(input([pos()], [quote()])).positions[0];
    expect([row?.fxSource, row?.fxDate]).toEqual(["flex", "2026-10-14"]);
    expect(v(row?.valueBase as Money)).toBeCloseTo(2320 * 0.92, 8);
  });

  it("a position in the base currency needs no rate", () => {
    const row = buildPortfolioView(
      input([pos({ currency: "EUR", fxRateToBase: null })], [quote({ currency: "EUR" })]),
    ).positions[0];
    expect(row?.fxSource).toBe("base");
    expect(v(row?.valueBase as Money)).toBe(2320);
  });

  it("without any rate the base figures are unavailable, the position is excluded from the totals with a reason, and the native breakdown keeps it", () => {
    const view = buildPortfolioView(input([pos({ fxRateToBase: null })], [quote()]));
    expect(view.positions[0]?.valueBase.kind).toBe("unavailable");
    expect(view.positions[0]?.fxSource).toBe("unavailable");
    expect(view.totals.valueBase.kind).toBe("unavailable");
    expect(view.totals.excluded).toEqual([{ symbol: "AAPL", reason: "Missing FX rate USD->EUR" }]);
    expect(v(view.perCurrency[0]?.value as Money)).toBe(2320);
    expect(view.perCurrency[0]?.ccy).toBe("USD");
  });
});

describe("totals", () => {
  const shel = pos({
    id: 2,
    conid: 100002,
    symbol: "SHEL",
    currency: "GBP",
    quantity: 100,
    costBasisMoney: 2500,
    markPrice: 27.35,
    fifoPnlUnrealized: 235,
    fxRateToBase: 1.15,
    valuationSymbol: "SHEL.L",
  });
  const quotes = [quote(), quote({ symbol: "SHEL.L", price: 2735, currency: "GBp" })];
  const fx = { "USD>EUR": yahoo(0.93), "GBP>EUR": yahoo(1.16) };

  it("sums mixed currencies only after conversion and breaks them down per currency", () => {
    const view = buildPortfolioView(input([pos(), shel], quotes, fx));
    expect(v(view.totals.valueBase)).toBeCloseTo(2320 * 0.93 + 2735 * 1.16, 6);
    expect(v(view.totals.costBase)).toBeCloseTo(2001.7 * 0.93 + 2500 * 1.16, 6);
    expect(view.perCurrency.map((c) => c.ccy)).toEqual(["GBP", "USD"]);
    expect(v(view.perCurrency[1]?.value as Money)).toBe(2320);
  });

  it("a position without cost basis is excluded from the totals with the reason", () => {
    const view = buildPortfolioView(
      input(
        [pos(), pos({ id: 3, symbol: "ZZZ", costBasisMoney: null, valuationSymbol: null })],
        quotes,
        fx,
      ),
    );
    expect(view.totals.excluded.map((e) => e.symbol)).toEqual(["ZZZ"]);
    expect(v(view.totals.valueBase)).toBeCloseTo(2320 * 0.93, 8);
  });

  it("daily P&L excludes positions without a delayed quote and counts them", () => {
    const view = buildPortfolioView(input([pos(), shel], [quote()], fx));
    expect(view.totals.dailyExcluded).toBe(1);
    expect(v(view.totals.dailyBase)).toBeCloseTo(10 * (232 - 232 / 1.01) * 0.93, 6);
  });

  it("an empty portfolio is a real zero in the base currency", () => {
    const view = buildPortfolioView(input([], []));
    expect(view.totals.valueBase).toEqual({ kind: "ok", value: 0, ccy: "EUR" });
    expect(view.totals.included).toBe(0);
  });
});

describe("statement reconciliation marker and tags", () => {
  it("flags a Flex unrealized value that does not reconcile with the statement mark price; null when not comparable", () => {
    expect(
      buildPortfolioView(input([pos({ fifoPnlUnrealized: 100 })], [quote()])).positions[0]
        ?.reconciles,
    ).toBe(false);
    expect(
      buildPortfolioView(input([pos({ fifoPnlUnrealized: null })], [quote()])).positions[0]
        ?.reconciles,
    ).toBeNull();
  });

  it("tags: not evaluated is Unavailable with a reason, scan tags keep their basis, none stays none", () => {
    const rows = buildPortfolioView(
      input(
        [
          pos({ id: 1 }),
          pos({
            id: 2,
            symbol: "B",
            valuationTag: "discounted",
            valuationReason: "based on close of 2026-10-14",
            valuationSessionDate: "2026-10-14",
          }),
          pos({
            id: 3,
            symbol: "C",
            valuationTag: "none",
            valuationReason: "based on close of 2026-10-14",
          }),
          pos({
            id: 4,
            symbol: "D",
            valuationTag: "unavailable",
            valuationReason: "no Yahoo match",
          }),
        ],
        [quote()],
      ),
    ).positions;
    expect(rows.map((r) => r.tag)).toEqual(["unavailable", "discounted", "none", "unavailable"]);
    expect(rows[0]?.tagBasis).toBe("not evaluated yet");
    expect(rows[1]?.tagBasis).toBe("based on close of 2026-10-14");
    expect(rows[3]?.tagBasis).toBe("no Yahoo match");
  });
});

describe("snapshot selection and FX pairs", () => {
  it("only the newest report date is used (an older snapshot is never presented as current)", () => {
    const rows = [
      pos({ id: 1, reportDate: "2026-10-13" }),
      pos({ id: 2, reportDate: "2026-10-14" }),
      pos({ id: 3, reportDate: "2026-10-14" }),
    ];
    expect(selectLatestSnapshot(rows).map((r) => r.id)).toEqual([2, 3]);
    expect(selectLatestSnapshot([])).toEqual([]);
  });

  it("neededFxPairs lists position->base and quote->position pairs once", () => {
    const shel = pos({ id: 2, symbol: "SHEL", currency: "GBP", valuationSymbol: "SHEL.L" });
    const pairs = neededFxPairs(
      [pos(), pos({ id: 5 }), shel],
      new Map([
        ["SHEL.L", quote({ symbol: "SHEL.L", currency: "GBp" })],
        ["AAPL", quote({ currency: "EUR" })],
      ]),
      "EUR",
    );
    expect(pairs).toEqual([
      { from: "USD", to: "EUR" },
      { from: "EUR", to: "USD" },
      { from: "GBP", to: "EUR" },
    ]);
  });
});
