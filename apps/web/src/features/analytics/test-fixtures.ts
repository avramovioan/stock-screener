import type { AnalyticsData } from "./analytics-data";

/** EUR account; the numbers of the Flex fixture (partial sale of SHEL, AAPL dividend and withholding, deposit and fee, two NAV rows). */
export function makeData(o: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    lots: [
      {
        conid: 100002,
        ccy: "GBP",
        qty: 3,
        costBasis: 75,
        proceeds: 79.5,
        realizedPnl: 4.2,
        closeDate: "2026-10-08",
        fxToBase: 1.15,
        key: "lot-a",
      },
      {
        conid: 100002,
        ccy: "GBP",
        qty: 1,
        costBasis: 26,
        proceeds: 26.5,
        realizedPnl: 0.4,
        closeDate: "2026-10-08",
        fxToBase: 1.15,
        key: "lot-b",
      },
    ],
    cash: [
      {
        date: "2026-10-10",
        ccy: "USD",
        amount: 2.6,
        category: "dividend",
        conid: 100001,
        fxToBase: 0.92,
      },
      {
        date: "2026-10-10",
        ccy: "USD",
        amount: -0.39,
        category: "withholding_tax",
        conid: 100001,
        fxToBase: 0.92,
      },
      {
        date: "2026-09-16",
        ccy: "EUR",
        amount: 5000,
        category: "deposit_withdrawal",
        conid: null,
        fxToBase: 1,
      },
      { date: "2026-10-01", ccy: "EUR", amount: -2, category: "fee", conid: null, fxToBase: 1 },
    ],
    trades: [
      {
        commission: -1,
        commissionCcy: "USD",
        tradeCcy: "USD",
        fxToBase: 0.92,
        tradeDate: "2026-10-09",
      },
      {
        commission: -0.7,
        commissionCcy: "USD",
        tradeCcy: "USD",
        fxToBase: 0.92,
        tradeDate: "2026-10-09",
      },
      {
        commission: -0.4,
        commissionCcy: "GBP",
        tradeCcy: "GBP",
        fxToBase: 1.15,
        tradeDate: "2026-10-08",
      },
    ],
    nav: [
      { date: "2026-10-13", total: 9800.55, ccy: "EUR" },
      { date: "2026-10-14", total: 9950.2, ccy: "EUR" },
    ],
    fxRates: [
      { rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 },
      { rateDate: "2026-10-14", fromCcy: "GBP", toCcy: "EUR", rate: 1.15 },
    ],
    positions: [
      { ccy: "USD", costBasisMoney: 2001.7, fifoUnrealized: 298.3, fxToBase: 0.92 },
      { ccy: "GBP", costBasisMoney: 2500, fifoUnrealized: 235, fxToBase: 1.15 },
    ],
    baseCurrency: "EUR",
    coverageFrom: "2025-10-15",
    lastStatementDate: "2026-10-14",
    hasUnvaluedTransfers: false,
    ...o,
  };
}
