// Figures of the Analytics page and their definitions (spec 12.9, 4.9). Pure: all inputs are arguments.
import {
  afterOtherCosts,
  type CashTx,
  combinedPerformance,
  commissionSummary,
  convertMoney,
  dividendSummary,
  type FlexRateRow,
  flexRateFor,
  type Money,
  ok,
  otherCostsSummary,
  performanceSeries,
  realizedSummary,
  sumInBase,
  unavailable,
} from "@core/accounting.ts";
import type { PortfolioView } from "@core/portfolio-view.ts";
import { formatSessionDate } from "@/lib/format";
import type { AnalyticsData } from "./analytics-data";

export interface PerCurrencyRow {
  ccy: string;
  realized: Money;
  dividendsGross: Money;
  dividendsWithholding: Money;
  dividendsNet: Money;
  commissions: Money;
  otherCosts: Money;
  cost: Money;
  value: Money;
  unrealized: Money;
}

export interface AnalyticsModel {
  totalValue: { nav: Money; navDate: string | null; calculated: Money };
  costBasis: Money;
  unrealized: { calculated: Money; broker: Money };
  realized: { base: Money; byCcy: Record<string, number>; lotCount: number };
  dividends: { gross: Money; withholding: Money; net: Money };
  costs: { commissions: Money; other: Money };
  combined: Money;
  combinedAfterOtherCosts: Money;
  historical: ReturnType<typeof performanceSeries>;
  navPoints: Array<{ date: string; value: number }>;
  perCurrency: PerCurrencyRow[];
  coverage: string;
  includeDividends: boolean;
}

export function coverageText(from: string | null, to: string | null): string {
  if (from === null) return "No statement history is loaded yet.";
  const start = formatSessionDate(from);
  const range = to === null ? `from ${start}` : `from ${start} to ${formatSessionDate(to)}`;
  return `History loaded ${range} — earlier activity is not included. Realized P&L may be incomplete before ${start}.`;
}

const rowRate = (fx: number | null, date: string) =>
  fx === null ? null : { rate: fx, rateDate: date, source: "flex" as const };

function commissionRows(data: AnalyticsData, base: string) {
  return data.trades
    .filter((t): t is typeof t & { commission: number } => t.commission !== null)
    .map((t) => {
      const fx =
        t.commissionCcy === t.tradeCcy
          ? t.fxToBase
          : (flexRateFor(data.fxRates as FlexRateRow[], t.commissionCcy, base, t.tradeDate)?.rate ??
            null);
      return { commission: t.commission, ccy: t.commissionCcy, fxToBase: fx };
    });
}

/** NAV rows oldest first, as chart points. */
export function navSeries(
  nav: readonly { date: string; total: number }[],
): Array<{ date: string; value: number }> {
  return [...nav]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((n) => ({ date: n.date, value: n.total }));
}

export function buildAnalytics(i: {
  base: string;
  includeDividends: boolean;
  view: PortfolioView | null;
  data: AnalyticsData;
}): AnalyticsModel {
  const { base, data, view } = i;
  const lastNav = [...data.nav].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
  const navDate = lastNav?.date ?? null;

  const costItems = data.positions.map((p) =>
    p.costBasisMoney === null
      ? unavailable("Cost basis missing in the statement")
      : convertMoney(p.costBasisMoney, p.ccy, base, rowRate(p.fxToBase, navDate ?? "")),
  );
  const brokerUnrealized = data.positions.map((p) =>
    p.fifoUnrealized === null
      ? unavailable("FIFO unrealized P&L missing in the statement")
      : convertMoney(p.fifoUnrealized, p.ccy, base, rowRate(p.fxToBase, navDate ?? "")),
  );

  const realized = realizedSummary(data.lots, base);
  const dividends = dividendSummary(data.cash, base);
  const commissions = commissionSummary(commissionRows(data, base), base);
  const other = otherCostsSummary(data.cash, base);

  const calculatedUnrealized: Money =
    view === null ? unavailable("Positions are not valued yet") : view.totals.unrealizedBase;
  const combined = combinedPerformance({
    realized: realized.realizedBase,
    unrealized: calculatedUnrealized,
    dividendsNet: dividends.netBase,
    includeDividends: i.includeDividends,
  });

  const currencies = new Set<string>();
  for (const l of data.lots) currencies.add(l.ccy);
  for (const c of data.cash) currencies.add(c.ccy);
  for (const t of data.trades) currencies.add(t.commissionCcy);
  for (const c of view?.perCurrency ?? []) currencies.add(c.ccy);
  const perCurrency: PerCurrencyRow[] = [...currencies].sort().map((ccy) => {
    const cash = data.cash.filter((c) => c.ccy === ccy);
    const div = dividendSummary(cash, ccy);
    const realizedNative = realized.byCcy[ccy];
    const held = view?.perCurrency.find((c) => c.ccy === ccy);
    return {
      ccy,
      realized: ok(realizedNative ?? 0, ccy),
      dividendsGross: div.grossBase,
      dividendsWithholding: div.withholdingBase,
      dividendsNet: div.netBase,
      commissions: commissionSummary(
        commissionRows(
          { ...data, trades: data.trades.filter((t) => t.commissionCcy === ccy) },
          ccy,
        ),
        ccy,
      ),
      otherCosts: otherCostsSummary(cash, ccy),
      cost:
        view === null ? unavailable("Positions are not valued yet") : (held?.cost ?? ok(0, ccy)),
      value:
        view === null ? unavailable("Positions are not valued yet") : (held?.value ?? ok(0, ccy)),
      unrealized:
        view === null
          ? unavailable("Positions are not valued yet")
          : (held?.unrealized ?? ok(0, ccy)),
    };
  });

  const flows: CashTx[] = data.cash;
  return {
    totalValue: {
      nav:
        lastNav === undefined
          ? unavailable("No NAV row in the loaded statements")
          : ok(lastNav.total, lastNav.ccy),
      navDate,
      calculated:
        view === null ? unavailable("Positions are not valued yet") : view.totals.valueBase,
    },
    costBasis: sumInBase(costItems, { ccy: base }),
    unrealized: {
      calculated: calculatedUnrealized,
      broker: sumInBase(brokerUnrealized, { ccy: base }),
    },
    realized: { base: realized.realizedBase, byCcy: realized.byCcy, lotCount: realized.lotCount },
    dividends: {
      gross: dividends.grossBase,
      withholding: dividends.withholdingBase,
      net: dividends.netBase,
    },
    costs: { commissions, other },
    combined,
    combinedAfterOtherCosts: afterOtherCosts(combined, other),
    historical: performanceSeries(data.nav, flows, base, {
      flowsComplete: !data.hasUnvaluedTransfers,
    }),
    navPoints: navSeries(data.nav),
    perCurrency,
    coverage: coverageText(data.coverageFrom, data.lastStatementDate),
    includeDividends: i.includeDividends,
  };
}
