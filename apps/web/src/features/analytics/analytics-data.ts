import type { CashTx, ClosedLot, FlexRateRow, NavPoint } from "@core/accounting.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PAGE_SIZE = 1000;

export interface StatementPosition {
  ccy: string;
  costBasisMoney: number | null;
  fifoUnrealized: number | null;
  fxToBase: number | null;
}

export interface CommissionRow {
  commission: number | null;
  commissionCcy: string;
  tradeCcy: string;
  fxToBase: number | null;
  tradeDate: string;
}

export interface AnalyticsData {
  lots: ClosedLot[];
  cash: CashTx[];
  trades: CommissionRow[];
  nav: NavPoint[];
  fxRates: FlexRateRow[];
  positions: StatementPosition[];
  baseCurrency: string | null;
  coverageFrom: string | null;
  lastStatementDate: string | null;
  /** ACATS/internal transfers exist: their value is not in the cash flows, so historical performance is unavailable (spec 12.9) */
  hasUnvaluedTransfers: boolean;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const opt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const mapLot = (r: Raw): ClosedLot => ({
  conid: num(r["conid"]),
  ccy: String(r["currency"]),
  qty: num(r["quantity"]),
  costBasis: num(r["cost_basis"]),
  proceeds: num(r["proceeds"] ?? 0),
  realizedPnl: num(r["fifo_pnl_realized"]),
  closeDate: String(r["close_date"]),
  fxToBase: opt(r["fx_rate_to_base"]),
  key: String(r["dedupe_hash"]),
});

export const mapCash = (r: Raw): CashTx => ({
  date: String(r["occurred_at"]).slice(0, 10),
  ccy: String(r["currency"]),
  amount: num(r["amount"]),
  category: r["category"] as CashTx["category"],
  conid: opt(r["conid"]),
  fxToBase: opt(r["fx_rate_to_base"]),
});

export const mapPosition = (r: Raw): StatementPosition => ({
  ccy: String(r["currency"]),
  costBasisMoney: opt(r["cost_basis_money"]),
  fifoUnrealized: opt(r["fifo_pnl_unrealized"]),
  fxToBase: opt(r["fx_rate_to_base"]),
});

export const mapNav = (r: Raw): NavPoint => ({
  date: String(r["report_date"]),
  total: num(r["total"]),
  ccy: String(r["currency"]),
});

export const mapRate = (r: Raw): FlexRateRow => ({
  rateDate: String(r["rate_date"]),
  fromCcy: String(r["from_ccy"]),
  toCcy: String(r["to_ccy"]),
  rate: num(r["rate"]),
});

export const mapCommission = (r: Raw): CommissionRow => ({
  commission: opt(r["ib_commission"]),
  commissionCcy: String(r["ib_commission_currency"] ?? r["currency"]),
  tradeCcy: String(r["currency"]),
  fxToBase: opt(r["fx_rate_to_base"]),
  tradeDate: String(r["trade_date"]),
});

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 500; page++) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error("Could not load the statement history.");
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error("Could not load the statement history.");
}

type PageResult = PromiseLike<{ data: Raw[] | null; error: unknown }>;

/** Reads the statement tables under RLS (own rows only). Deterministic paging: every table is ordered by its identity column. */
export async function loadAnalyticsData(
  client: Pick<SupabaseClient, "from">,
): Promise<AnalyticsData> {
  const read = (table: string, columns: string) =>
    fetchAllPages<Raw>(
      (a, b) =>
        client
          .from(table)
          .select(columns)
          .order("id", { ascending: true })
          .range(a, b) as unknown as PageResult,
    );

  const latest = await client
    .from("broker_positions")
    .select("report_date")
    .order("report_date", { ascending: false })
    .limit(1);
  if (latest.error) throw new Error("Could not load the statement history.");
  const latestDate = ((latest.data as Array<{ report_date: string }> | null) ?? [])[0]?.report_date;
  const connection = await client
    .from("broker_connections")
    .select("base_currency,coverage_from,last_statement_date")
    .maybeSingle();
  if (connection.error) throw new Error("Could not load the statement history.");
  const transfers = await client
    .from("broker_corporate_actions")
    .select("id", { count: "exact", head: true })
    .eq("kind", "transfer");
  if (transfers.error) throw new Error("Could not load the statement history.");

  const [lots, cash, trades, nav, rates, positions] = await Promise.all([
    read(
      "broker_closed_lots",
      "id,conid,currency,quantity,cost_basis,proceeds,fifo_pnl_realized,close_date,fx_rate_to_base,dedupe_hash",
    ),
    read(
      "broker_cash_transactions",
      "id,occurred_at,currency,amount,category,conid,fx_rate_to_base",
    ),
    read(
      "broker_trades",
      "id,ib_commission,ib_commission_currency,currency,fx_rate_to_base,trade_date",
    ),
    read("broker_nav", "id,report_date,currency,total"),
    read("broker_fx_rates", "id,rate_date,from_ccy,to_ccy,rate"),
    latestDate === undefined
      ? Promise.resolve([] as Raw[])
      : fetchAllPages<Raw>(
          (a, b) =>
            client
              .from("broker_positions")
              .select("id,currency,cost_basis_money,fifo_pnl_unrealized,fx_rate_to_base")
              .eq("report_date", latestDate)
              .order("id")
              .range(a, b) as unknown as PageResult,
        ),
  ]);
  const c = connection.data as {
    base_currency: string | null;
    coverage_from: string | null;
    last_statement_date: string | null;
  } | null;
  return {
    lots: lots.map(mapLot),
    cash: cash.map(mapCash),
    trades: trades.map(mapCommission),
    nav: nav.map(mapNav),
    fxRates: rates.map(mapRate),
    positions: positions.map(mapPosition),
    baseCurrency: c?.base_currency ?? null,
    coverageFrom: c?.coverage_from ?? null,
    lastStatementDate: c?.last_statement_date ?? null,
    hasUnvaluedTransfers: (transfers.count ?? 0) > 0,
  };
}
