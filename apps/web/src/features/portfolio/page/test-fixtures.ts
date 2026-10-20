import type { Money } from "@core/accounting.ts";
import type { PortfolioTotals, PortfolioView, PositionView } from "@core/portfolio-view.ts";
import type { ClientPortfolio } from "../portfolio-api";

export const ok = (value: number, ccy: string): Money => ({ kind: "ok", value, ccy });
export const na = (reason: string): Money => ({ kind: "unavailable", reason });

export function makeRow(o: Partial<PositionView> = {}): PositionView {
  return {
    id: 1,
    conid: 100001,
    ticker: "AAPL",
    name: "APPLE INC",
    assetClass: "STK",
    currency: "USD",
    quantity: 10,
    multiplier: 1,
    price: {
      value: 232,
      ccy: "USD",
      source: {
        kind: "delayed_quote",
        asOfMs: Date.UTC(2026, 9, 15, 6, 59),
        marketState: "REGULAR",
        fetchedAtMs: Date.UTC(2026, 9, 15, 7, 0),
      },
      note: null,
    },
    quoteTime: "2026-10-15T06:59:00.000Z",
    costBasis: ok(2001.7, "USD"),
    marketValue: ok(2320, "USD"),
    averageCost: 200.17,
    dailyPnl: ok(22.97, "USD"),
    unrealizedIndependent: ok(318.3, "USD"),
    unrealizedBroker: 298.3,
    reconciles: true,
    valueBase: ok(2157.6, "EUR"),
    costBase: ok(1861.58, "EUR"),
    unrealizedBase: ok(296.02, "EUR"),
    dailyBase: ok(21.36, "EUR"),
    fxSource: "yahoo",
    fxDate: "2026-10-15",
    tag: "none",
    tagBasis: "based on close of 2026-10-14",
    matchStatus: "matched_isin",
    ...o,
  };
}

export const SHEL = (o: Partial<PositionView> = {}): PositionView =>
  makeRow({
    id: 2,
    conid: 100002,
    ticker: "SHEL",
    name: "SHELL PLC",
    currency: "GBP",
    quantity: 100,
    price: {
      value: 24.31,
      ccy: "GBP",
      source: { kind: "statement_close", reportDate: "2026-10-14", reason: "no delayed quote" },
      note: null,
    },
    quoteTime: null,
    costBasis: ok(2500, "GBP"),
    marketValue: ok(2431, "GBP"),
    averageCost: 25,
    dailyPnl: na("Daily change needs a delayed quote"),
    unrealizedIndependent: ok(-69, "GBP"),
    unrealizedBroker: -69,
    valueBase: ok(2819.96, "EUR"),
    costBase: ok(2900, "EUR"),
    unrealizedBase: ok(-80.04, "EUR"),
    dailyBase: na("Daily change needs a delayed quote"),
    tag: "extra_premium",
    ...o,
  });

export const NOPX = (o: Partial<PositionView> = {}): PositionView =>
  makeRow({
    id: 3,
    conid: 100003,
    ticker: "NOPX",
    name: "NO PRICE CORP",
    price: {
      value: null,
      ccy: "USD",
      source: { kind: "unavailable", reason: "no delayed quote" },
      note: null,
    },
    quoteTime: null,
    costBasis: na("Cost basis missing in the statement"),
    marketValue: na("no delayed quote"),
    averageCost: null,
    dailyPnl: na("Daily change needs a delayed quote"),
    unrealizedIndependent: na("Cost basis missing in the statement"),
    unrealizedBroker: null,
    reconciles: null,
    valueBase: na("no delayed quote"),
    costBase: na("Cost basis missing in the statement"),
    unrealizedBase: na("Cost basis missing in the statement"),
    dailyBase: na("Daily change needs a delayed quote"),
    fxSource: "unavailable",
    fxDate: null,
    tag: "unavailable",
    tagBasis: "no Yahoo match",
    ...o,
  });

export function makeTotals(o: Partial<PortfolioTotals> = {}): PortfolioTotals {
  return {
    costBase: ok(1861.58 + 2900, "EUR"),
    valueBase: ok(2157.6 + 2819.96, "EUR"),
    unrealizedBase: ok(296.02 - 80.04, "EUR"),
    dailyBase: ok(21.36, "EUR"),
    included: 2,
    excluded: [{ symbol: "NOPX", reason: "Cost basis missing in the statement" }],
    dailyExcluded: 1,
    ...o,
  };
}

export function makeView(
  rows: PositionView[] = [makeRow(), SHEL(), NOPX()],
  o: Partial<PortfolioView> = {},
): PortfolioView {
  return {
    baseCurrency: "EUR",
    reportDate: "2026-10-14",
    positions: rows,
    totals: makeTotals(),
    perCurrency: [
      {
        ccy: "GBP",
        count: 1,
        excluded: 0,
        cost: ok(2500, "GBP"),
        value: ok(2431, "GBP"),
        unrealized: ok(-69, "GBP"),
        daily: na("Daily change needs a delayed quote"),
      },
      {
        ccy: "USD",
        count: 1,
        excluded: 1,
        cost: ok(2001.7, "USD"),
        value: ok(2320, "USD"),
        unrealized: ok(318.3, "USD"),
        daily: ok(22.97, "USD"),
      },
    ],
    quotesFetchedAt: "2026-10-15T07:00:00.000Z",
    ...o,
  };
}

export function makeResponse(o: Partial<ClientPortfolio> = {}): ClientPortfolio {
  const now = Date.UTC(2026, 9, 15, 7, 0, 0);
  return {
    serverTime: new Date(now).toISOString(),
    nextAutoRefreshAt: new Date(now + 300_000).toISOString(),
    manualAvailableAt: new Date(now).toISOString(),
    lastSuccessfulAt: "2026-10-15T07:00:00.000Z",
    baseCurrency: "EUR",
    reportDate: "2026-10-14",
    lastStatementDate: "2026-10-14",
    statement: { expectedDate: "2026-10-14", freshness: { kind: "current" } },
    syncQueued: false,
    quoteError: null,
    view: makeView(),
    receivedAtMs: now,
    ...o,
  };
}
