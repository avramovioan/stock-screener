import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { formatSessionDate } from "@/lib/format";
import { formatAmount, MoneyText } from "../money-text";
import { ProvenanceBadge } from "../provenance";
import { filtersFromSearch, type PortfolioSearch, searchFromFilters } from "./search-params";
import { TradeFilterBar } from "./trade-filters";
import { hasFilters, TRADES_PAGE_SIZE, type TradeFilters, type TradeRow } from "./trades-api";
import { useTradeCurrencies, useTrades } from "./use-trades";

const qty = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });
const HEADERS = [
  "Date",
  "Instrument",
  "Action",
  "Quantity",
  "Execution price",
  "Exchange",
  "Commission",
  "Net cash",
  "Realized P&L",
  "Order",
];
const NUMERIC_HEADERS = new Set([
  "Quantity",
  "Execution price",
  "Commission",
  "Net cash",
  "Realized P&L",
]);

const Reported = () => (
  <div>
    <ProvenanceBadge kind="broker" />
  </div>
);

function realized(r: TradeRow) {
  if (r.fifo_pnl_realized === null || (r.open_close !== "C" && r.fifo_pnl_realized === 0)) {
    return <MoneyText money={{ kind: "unavailable", reason: "opening trade, nothing realized" }} />;
  }
  return (
    <>
      <MoneyText money={{ kind: "ok", value: r.fifo_pnl_realized, ccy: r.currency }} signed />
      <Reported />
    </>
  );
}

const cost = (r: TradeRow) =>
  r.ib_commission === null ? (
    <MoneyText money={{ kind: "unavailable", reason: "commission not reported" }} />
  ) : (
    <>
      <span className="tabular-nums">{`${formatAmount(Math.abs(r.ib_commission))} ${r.ib_commission_currency ?? r.currency}`}</span>
      <Reported />
    </>
  );

const net = (r: TradeRow) =>
  r.net_cash === null ? (
    <MoneyText money={{ kind: "unavailable", reason: "net cash not reported" }} />
  ) : (
    <>
      <MoneyText money={{ kind: "ok", value: r.net_cash, ccy: r.currency }} signed />
      <Reported />
    </>
  );

function orderLabel(r: TradeRow, fills: Map<string, number>): string {
  if (r.ib_order_id === null) return "—";
  const n = fills.get(r.ib_order_id) ?? 1;
  return `Order ${r.ib_order_id}${n > 1 ? ` (${n} fills)` : ""}`;
}

const action = (r: TradeRow) => (r.buy_sell === "BUY" ? "Buy" : "Sell");
const venue = (r: TradeRow) => r.exchange ?? r.listing_exchange ?? "—";

export function TradeHistory() {
  const search = useSearch({ strict: false }) as PortfolioSearch;
  const navigate = useNavigate();
  const filters = filtersFromSearch(search);
  const filterKey = JSON.stringify(filters);
  // paging restarts at the first page whenever a filter changes
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const page = paging.key === filterKey ? paging.page : 0;
  const setPage = (update: (p: number) => number) =>
    setPaging({ key: filterKey, page: update(page) });
  const q = useTrades(page, filters);
  const currencies = useTradeCurrencies();
  const filtered = hasFilters(filters);
  const onFilters = (next: TradeFilters) => {
    void navigate({ to: ".", search: searchFromFilters(next) as never, replace: true });
  };
  if (q.isLoading) return <Loading label="Loading trade history" rows={4} />;
  if (q.isError && q.data === undefined)
    return (
      <div className="space-y-3">
        {filtered ? (
          <TradeFilterBar
            filters={filters}
            currencies={currencies.data ?? []}
            onChange={onFilters}
          />
        ) : null}
        <ErrorState
          title="Trade history unavailable"
          message="Could not load the trade history."
          onRetry={() => void q.refetch()}
        />
      </div>
    );
  const data = q.data;
  if (data === undefined || (data.total === 0 && !filtered))
    return (
      <EmptyState
        title="No executions in the loaded statements."
        description="Executions from your IBKR statements appear here, newest first."
      />
    );

  const fills = new Map<string, number>();
  for (const r of data.rows)
    if (r.ib_order_id !== null) fills.set(r.ib_order_id, (fills.get(r.ib_order_id) ?? 0) + 1);
  const first = page * TRADES_PAGE_SIZE + 1;
  const last = Math.min(data.total, page * TRADES_PAGE_SIZE + data.rows.length);
  const pages = Math.max(1, Math.ceil(data.total / TRADES_PAGE_SIZE));

  return (
    <section aria-labelledby="trade-history-title" className="space-y-3">
      <h2 id="trade-history-title" className="text-lg font-semibold">
        Trade history
      </h2>
      <p className="text-xs text-muted-foreground">
        Executions from your IBKR statements (not orders). Times are as reported by IBKR. Realized
        P&L appears only on closing executions.
      </p>

      <TradeFilterBar filters={filters} currencies={currencies.data ?? []} onChange={onFilters} />
      <p className="text-sm text-muted-foreground" data-testid="trades-match-count">
        {data.total === 1 ? "1 execution matches" : `${data.total} executions match`}
      </p>
      {data.total === 0 ? (
        <EmptyState
          title="No executions match these filters."
          description="Widen the dates or clear a filter."
        />
      ) : (
        <>
          <table data-testid="trades-table" className="hidden w-full text-sm md:table">
            <thead>
              <tr>
                {HEADERS.map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className={`px-2 py-2 font-medium ${NUMERIC_HEADERS.has(h) ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.ib_exec_id} className="border-t align-top">
                  <td className="px-2 py-2">
                    <span>{formatSessionDate(r.trade_date)}</span>
                    {r.trade_time !== null ? (
                      <small
                        className="block text-xs text-muted-foreground"
                        title="Time as reported by IBKR"
                      >
                        {r.trade_time}
                      </small>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <span data-testid="trade-symbol" className="font-medium">
                      {r.symbol}
                    </span>
                    {r.description !== null ? (
                      <small className="block text-xs text-muted-foreground">{r.description}</small>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">{action(r)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {qty.format(Math.abs(r.quantity))}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{`${formatAmount(r.trade_price)} ${r.currency}`}</td>
                  <td className="px-2 py-2">{venue(r)}</td>
                  <td className="px-2 py-2 text-right">{cost(r)}</td>
                  <td className="px-2 py-2 text-right">{net(r)}</td>
                  <td className="px-2 py-2 text-right">{realized(r)}</td>
                  <td className="px-2 py-2 text-xs">{orderLabel(r, fills)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="space-y-3 md:hidden">
            {data.rows.map((r) => (
              <li
                key={r.ib_exec_id}
                data-testid={`trade-card-${r.ib_exec_id}`}
                className="rounded-md border p-3"
              >
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Date</dt>
                  <dd className="text-right">
                    {formatSessionDate(r.trade_date)}
                    {r.trade_time !== null ? ` ${r.trade_time}` : ""}
                  </dd>
                  <dt className="text-muted-foreground">Instrument</dt>
                  <dd className="text-right">{r.symbol}</dd>
                  <dt className="text-muted-foreground">Action</dt>
                  <dd className="text-right">{action(r)}</dd>
                  <dt className="text-muted-foreground">Quantity</dt>
                  <dd className="text-right tabular-nums">{qty.format(Math.abs(r.quantity))}</dd>
                  <dt className="text-muted-foreground">Execution price</dt>
                  <dd className="text-right tabular-nums">{`${formatAmount(r.trade_price)} ${r.currency}`}</dd>
                  <dt className="text-muted-foreground">Exchange</dt>
                  <dd className="text-right">{venue(r)}</dd>
                  <dt className="text-muted-foreground">Commission</dt>
                  <dd className="text-right">{cost(r)}</dd>
                  <dt className="text-muted-foreground">Net cash</dt>
                  <dd className="text-right">{net(r)}</dd>
                  <dt className="text-muted-foreground">Realized P&L</dt>
                  <dd className="text-right">{realized(r)}</dd>
                  <dt className="text-muted-foreground">Order</dt>
                  <dd className="text-right">{orderLabel(r, fills)}</dd>
                </dl>
              </li>
            ))}
          </ul>

          <nav
            aria-label="Trade history pages"
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <p>{`Showing ${first}-${last} of ${data.total}`}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="min-h-11 rounded border px-3 py-1 disabled:opacity-50 md:min-h-8"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous page
              </button>
              <span>{`Page ${page + 1} of ${pages}`}</span>
              <button
                type="button"
                className="min-h-11 rounded border px-3 py-1 disabled:opacity-50 md:min-h-8"
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next page
              </button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
