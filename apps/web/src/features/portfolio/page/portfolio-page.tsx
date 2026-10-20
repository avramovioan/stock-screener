import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotLinkedError } from "../portfolio-api";
import { RefreshablePage, RefreshBar } from "../refresh-bar";
import { usePortfolio } from "../use-portfolio";
import { PositionsTable } from "./positions-table";
import { TradeHistory } from "./trade-history";
import { useHoldingLinks } from "./use-holding-links";

function NotLinked() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No broker is linked</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Link your IBKR account to see your positions, trades and analytics. The connection is
          read-only (IBKR Flex Web Service) and uses end-of-day statements.
        </p>
        <Button asChild className="min-h-11">
          <Link to="/profile/broker">Link your broker</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function PortfolioPage() {
  useEffect(() => {
    document.title = "Portfolio - Stock Screener";
  }, []);
  const q = usePortfolio();
  const holdings = useHoldingLinks();

  let body: ReactNode;
  if (q.isLoading) body = <Loading label="Loading portfolio" rows={6} />;
  else if (q.data === undefined && q.error instanceof NotLinkedError) body = <NotLinked />;
  else if (q.data === undefined)
    body = (
      <ErrorState
        message={q.error instanceof Error ? q.error.message : "Could not load the portfolio."}
        onRetry={() => void q.refetch()}
      />
    );
  else {
    const view = q.data.view;
    body = (
      <>
        <RefreshBar
          data={q.data}
          error={q.error instanceof Error ? q.error : null}
          fetching={q.isFetching}
        />
        {view.positions.length === 0 ? (
          <EmptyState
            title="No open positions in the latest statement."
            description="Positions appear after the next statement day."
          />
        ) : (
          <PositionsTable
            rows={view.positions}
            totals={view.totals}
            perCurrency={view.perCurrency}
            base={view.baseCurrency}
            links={holdings.data}
            reportDate={view.reportDate}
            onRevalued={() => {
              void q.refetch();
              void holdings.refetch();
            }}
          />
        )}
        <TradeHistory />
      </>
    );
  }

  return (
    <RefreshablePage enabled={q.data !== undefined}>
      <section aria-labelledby="page-title" className="space-y-6">
        <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
          Portfolio
        </h1>
        {body}
      </section>
    </RefreshablePage>
  );
}
