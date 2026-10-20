import type { Money } from "@core/accounting.ts";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyText } from "../portfolio/money-text";
import { NotLinkedError } from "../portfolio/portfolio-api";
import { RefreshablePage, RefreshBar } from "../portfolio/refresh-bar";
import { usePortfolio } from "../portfolio/use-portfolio";
import { type AnalyticsModel, buildAnalytics, navSeries } from "./analytics-model";
import { CurrencyTable } from "./components/currency-table";
import { DividendToggle } from "./components/dividend-toggle";
import { KpiCard } from "./components/kpi-card";
import { NavChart } from "./components/nav-chart";
import { useAnalyticsData } from "./use-analytics";

function NotLinked() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No broker is linked</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Analytics need your IBKR statements. Link your account (read-only, end-of-day data) to see
          performance, dividends and costs.
        </p>
        <Button asChild>
          <Link to="/profile/broker">Link your broker</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** Whole cents for a headline figure (MoneyText shows up to 6 decimals below 1). Unavailable stays unavailable. */
const cents = (m: Money): Money =>
  m.kind === "ok" ? { ...m, value: Math.round(m.value * 100) / 100 } : m;

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function historicalToMoney(h: AnalyticsModel["historical"], base: string): Money {
  if (h.kind !== "ok") return { kind: "unavailable", reason: h.reason };
  const last = h.points.at(-1);
  return last === undefined
    ? { kind: "unavailable", reason: "No NAV history" }
    : { kind: "ok", value: last.performance, ccy: base };
}

export function AnalyticsPage() {
  useEffect(() => {
    document.title = "Analytics - Stock Screener";
  }, []);
  const [includeDividends, setIncludeDividends] = useState(false);
  const portfolio = usePortfolio();
  const tables = useAnalyticsData({ enabled: portfolio.data !== undefined });
  const view = portfolio.data?.view ?? null;
  const base = portfolio.data?.baseCurrency ?? tables.data?.baseCurrency ?? "";
  const model = useMemo(
    () =>
      tables.data === undefined
        ? null
        : buildAnalytics({ base, includeDividends, view, data: tables.data }),
    [tables.data, base, includeDividends, view],
  );

  const navPoints = useMemo(
    () => (tables.data === undefined ? [] : navSeries(tables.data.nav)),
    [tables.data],
  );

  let body: ReactNode;
  if (portfolio.isLoading) body = <Loading label="Loading analytics" rows={6} />;
  else if (portfolio.data === undefined && portfolio.error instanceof NotLinkedError)
    body = <NotLinked />;
  else if (portfolio.data === undefined)
    body = (
      <ErrorState
        message={
          portfolio.error instanceof Error
            ? portfolio.error.message
            : "Could not load the portfolio."
        }
        onRetry={() => void portfolio.refetch()}
      />
    );
  else {
    body = (
      <>
        <RefreshBar
          data={portfolio.data}
          error={portfolio.error instanceof Error ? portfolio.error : null}
          fetching={portfolio.isFetching}
        />
        {tables.isLoading ? <Loading label="Loading statement history" rows={4} /> : null}
        {tables.isError && model === null ? (
          <ErrorState
            message="Could not load the statement history."
            onRetry={() => void tables.refetch()}
          />
        ) : null}
        {model !== null ? (
          <>
            <p className="text-sm">{model.coverage}</p>
            <DividendToggle checked={includeDividends} onChange={setIncludeDividends} />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                title="Total portfolio value"
                provenance={["broker", "calculated"]}
                note="NAV is the broker's statement value; the second line values the positions at delayed prices."
              >
                <Line
                  label={
                    model.totalValue.navDate === null ? "NAV" : `NAV at ${model.totalValue.navDate}`
                  }
                >
                  <MoneyText money={model.totalValue.nav} />
                </Line>
                <Line label="Positions at delayed prices">
                  <MoneyText money={model.totalValue.calculated} />
                </Line>
              </KpiCard>
              <KpiCard
                title="Cost basis of current positions"
                provenance={["broker"]}
                note="Flex cost basis converted with the Flex rates of the statement."
              >
                <Line label="Cost basis">
                  <MoneyText money={model.costBasis} />
                </Line>
              </KpiCard>
              <KpiCard
                title="Unrealized P&L"
                provenance={["calculated", "broker"]}
                note="The statement's FIFO figure is authoritative for the statement day; the calculated figure uses current prices."
              >
                <Line label="Calculated">
                  <MoneyText money={model.unrealized.calculated} signed />
                </Line>
                <Line label="Broker FIFO at the statement close">
                  <MoneyText money={model.unrealized.broker} signed />
                </Line>
              </KpiCard>
              <KpiCard
                title="Realized trading P&L"
                provenance={["broker"]}
                note="Commissions are already netted by IBKR and are not subtracted again."
              >
                <Line label="Realized (closed lots, base currency)">
                  <MoneyText money={model.realized.base} signed />
                </Line>
                <p className="text-xs text-muted-foreground">{`Re-summed from ${model.realized.lotCount} closed lot${model.realized.lotCount === 1 ? "" : "s"}, partial sales included.`}</p>
              </KpiCard>
              <KpiCard
                title="Dividends"
                provenance={["broker"]}
                note="Broker rows aggregated by this app; kept separate from trading P&L."
              >
                <Line label="Gross">
                  <MoneyText money={model.dividends.gross} />
                </Line>
                <Line label="Withholding tax">
                  <MoneyText money={cents(model.dividends.withholding)} />
                </Line>
                <Line label="Net">
                  <MoneyText money={model.dividends.net} signed />
                </Line>
              </KpiCard>
              <KpiCard title="Commissions and other costs" provenance={["broker"]}>
                <Line label="Commissions (memo)">
                  <MoneyText money={model.costs.commissions} />
                </Line>
                <p className="text-xs text-muted-foreground">
                  Commissions are already inside the realized P&L and are not deducted again.
                </p>
                <Line label="Other costs (fees and interest)">
                  <MoneyText money={model.costs.other} />
                </Line>
              </KpiCard>
              <KpiCard
                title="Combined performance"
                provenance={["calculated"]}
                note={
                  includeDividends
                    ? "Realized plus unrealized plus net dividends (dividends included)."
                    : "Realized plus unrealized (dividends excluded)."
                }
              >
                <Line label="Combined">
                  <MoneyText money={model.combined} signed />
                </Line>
                <Line label="After other costs">
                  <MoneyText money={model.combinedAfterOtherCosts} signed />
                </Line>
              </KpiCard>
              <KpiCard
                title="Historical performance"
                provenance={["calculated"]}
                note="NAV minus cumulative net deposits and withdrawals since the first NAV day."
              >
                <Line label="Since the first NAV day">
                  <MoneyText money={historicalToMoney(model.historical, base)} signed />
                </Line>
              </KpiCard>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Per-currency breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <CurrencyTable rows={model.perCurrency} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>NAV history</CardTitle>
              </CardHeader>
              <CardContent>
                <NavChart points={navPoints} currency={base} />
              </CardContent>
            </Card>
          </>
        ) : null}
        {portfolio.data.view.positions.length === 0 &&
        model === null &&
        !tables.isLoading &&
        !tables.isError ? (
          <EmptyState
            title="Nothing to analyse yet."
            description="Figures appear after the first statement is loaded."
          />
        ) : null}
      </>
    );
  }

  return (
    <RefreshablePage enabled={portfolio.data !== undefined}>
      <section aria-labelledby="page-title" className="space-y-6">
        <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
          Analytics
        </h1>
        {body}
      </section>
    </RefreshablePage>
  );
}
