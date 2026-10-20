import type { SupabaseClient } from "@supabase/supabase-js";

export const TRADES_PAGE_SIZE = 25;

export interface TradeRow {
  id: number;
  trade_id: string | null;
  ib_exec_id: string;
  ib_order_id: string | null;
  symbol: string;
  description: string | null;
  exchange: string | null;
  listing_exchange: string | null;
  currency: string;
  trade_date: string;
  trade_time: string | null;
  buy_sell: "BUY" | "SELL";
  quantity: number;
  trade_price: number;
  ib_commission: number | null;
  ib_commission_currency: string | null;
  net_cash: number | null;
  fifo_pnl_realized: number | null;
  open_close: string | null;
}

export interface TradesPage {
  rows: TradeRow[];
  total: number;
}

export type TradeType = "all" | "stocks" | "fx" | "bonds";
export type TradeSide = "all" | "BUY" | "SELL";

/** The trade history filter bar: all applied in the paged query (spec 5.8). Empty text means "no filter". */
export interface TradeFilters {
  /** Symbol or name, matched case-insensitively against `symbol` and `description`. */
  q: string;
  type: TradeType;
  side: TradeSide;
  /** Currency code; "" is All. */
  ccy: string;
  /** First trade date, `YYYY-MM-DD`; "" is open. */
  from: string;
  /** Last trade date (inclusive), `YYYY-MM-DD`; "" is open. */
  to: string;
}

export const NO_FILTERS: TradeFilters = {
  q: "",
  type: "all",
  side: "all",
  ccy: "",
  from: "",
  to: "",
};

export const hasFilters = (f: TradeFilters): boolean =>
  f.q !== "" ||
  f.type !== "all" ||
  f.side !== "all" ||
  f.ccy !== "" ||
  f.from !== "" ||
  f.to !== "";

export interface TradesApi {
  page(index: number, filters?: TradeFilters): Promise<TradesPage>;
  /** The distinct currencies seen in the user's executions, sorted. */
  currencies(): Promise<string[]>;
}

/** A currency conversion is recorded as `AAA.BBB` (for example EUR.USD). */
export const FX_SYMBOL = "^[A-Z]{3}\\.[A-Z]{3}$";
/** Bond symbols carry a coupon or maturity after a space (`T 4.5 02/15/36`); share classes (`BRK B`) have a space but no digit. broker_trades has no asset class column, so this shape stands in for it. */
export const BOND_SYMBOL = "^[^ ]+ .*[0-9]";
/** Characters that would break an `or=(...)` filter list. */
const LIST_PUNCTUATION = /[,()"*%\\]/g;

const COLUMNS =
  "id,trade_id,ib_exec_id,ib_order_id,symbol,description,exchange,listing_exchange,currency,trade_date,trade_time,buy_sell,quantity,trade_price,ib_commission,ib_commission_currency,net_cash,fifo_pnl_realized,open_close";
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Executions only (orders are out of scope): newest first, 25 per page, read under RLS. */
export function createTradesApi(client: Pick<SupabaseClient, "from">): TradesApi {
  return {
    async currencies() {
      const { data, error } = await client.from("broker_trades").select("currency").limit(5000);
      if (error) throw new Error("Could not load the currencies.");
      const seen = ((data as Array<{ currency: string }> | null) ?? []).map((r) => r.currency);
      return [...new Set(seen)].sort();
    },
    async page(index, filters = NO_FILTERS) {
      const from = index * TRADES_PAGE_SIZE;
      let query = client.from("broker_trades").select(COLUMNS, { count: "exact" });
      const text = filters.q.replace(LIST_PUNCTUATION, "").trim();
      if (text !== "") query = query.or(`symbol.ilike.*${text}*,description.ilike.*${text}*`);
      if (filters.type === "fx") query = query.filter("symbol", "match", FX_SYMBOL);
      if (filters.type === "bonds") query = query.filter("symbol", "match", BOND_SYMBOL);
      if (filters.type === "stocks")
        query = query.not("symbol", "match", FX_SYMBOL).not("symbol", "match", BOND_SYMBOL);
      if (filters.side !== "all") query = query.eq("buy_sell", filters.side);
      if (filters.ccy !== "") query = query.eq("currency", filters.ccy);
      if (filters.from !== "") query = query.gte("trade_date", filters.from);
      if (filters.to !== "") query = query.lte("trade_date", filters.to);
      const { data, error, count } = await query
        .order("trade_date", { ascending: false })
        .order("trade_time", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, from + TRADES_PAGE_SIZE - 1);
      if (error) throw new Error("Could not load the trade history.");
      const rows = ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
        ...(r as unknown as TradeRow),
        quantity: Number(r["quantity"]),
        trade_price: Number(r["trade_price"]),
        ib_commission: n(r["ib_commission"]),
        net_cash: n(r["net_cash"]),
        fifo_pnl_realized: n(r["fifo_pnl_realized"]),
      }));
      return { rows, total: count ?? rows.length };
    },
  };
}
