// Maps a parsed Flex statement to the JSON payload of app.broker_ingest_statement. Raw rows and unknown attributes are dropped here
// (raw statements are never stored, spec 12.10); the full account id never leaves the parser (only the masked form is stored).
import type { FlexPosition, FlexStatement } from "@adapters/flex-parse.ts";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function maskAccountId(id: string): string {
  return id.length <= 4 ? "***" : `${id.slice(0, 1)}***${id.slice(-4)}`;
}

/** Positions come from the latest report date in the file (multi-day windows: UNVERIFIED semantics, research flex 2.4). */
export function latestSnapshot(s: FlexStatement): {
  reportDate: string;
  positions: FlexPosition[];
} {
  const dates = s.positions.map((p) => p.reportDate).sort();
  const reportDate = dates.length === 0 ? s.toDate : (dates[dates.length - 1] as string);
  return { reportDate, positions: s.positions.filter((p) => p.reportDate === reportDate) };
}

const lastWins = <T>(items: readonly T[], key: (item: T) => string): T[] => [
  ...new Map(items.map((i) => [key(i), i])).values(),
];

export async function toIngestPayload(userId: string, s: FlexStatement) {
  const snap = latestSnapshot(s);

  const positions = snap.positions.map((p) => ({
    conid: p.conid,
    isin: p.isin,
    symbol: p.symbol,
    description: p.description,
    asset_class: p.assetClass,
    sub_category: p.subCategory,
    listing_exchange: p.listingExchange,
    currency: p.currency,
    fx_rate_to_base: p.fxRateToBase,
    quantity: p.quantity,
    multiplier: p.multiplier,
    mark_price: p.markPrice,
    position_value: p.positionValue,
    open_price: p.openPrice,
    cost_basis_price: p.costBasisPrice,
    cost_basis_money: p.costBasisMoney,
    fifo_pnl_unrealized: p.fifoPnlUnrealized,
    percent_of_nav: p.percentOfNav,
    level_of_detail: p.levelOfDetail,
    open_date_time: p.openDateTime,
  }));

  const trades = lastWins(s.trades, (t) => t.execId).map((t) => ({
    trade_id: t.tradeId,
    ib_exec_id: t.execId,
    ib_order_id: t.orderId,
    conid: t.conid,
    isin: t.isin,
    symbol: t.symbol,
    description: t.description,
    listing_exchange: t.listingExchange,
    exchange: t.exchange,
    currency: t.currency,
    fx_rate_to_base: t.fxRateToBase,
    trade_date: t.tradeDate,
    trade_time: t.tradeTime,
    settle_date: t.settleDate,
    buy_sell: t.buySell,
    quantity: t.quantity,
    trade_price: t.tradePrice,
    trade_money: t.tradeMoney,
    proceeds: t.proceeds,
    taxes: t.taxes,
    ib_commission: t.ibCommission,
    ib_commission_currency: t.ibCommissionCurrency,
    net_cash: t.netCash,
    cost_basis: t.costBasis,
    fifo_pnl_realized: t.fifoPnlRealized,
    open_close: t.openClose,
    order_type: t.orderType,
    report_date: t.reportDate,
  }));

  // identical rows inside one statement get an occurrence suffix so legitimate duplicates are not collapsed, and re-ingest stays idempotent
  const occurrences = new Map<string, number>();
  const nth = (base: string): number => {
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return n;
  };
  // spec 12.5: dedupe_hash = sha256(user, tradeID, openDateTime, quantity, costBasis): identical lots of one sale get an occurrence suffix
  const closedLots = [];
  for (const l of s.closedLots) {
    const base = [
      userId,
      l.closingTradeId ?? "",
      l.openDateTime ?? "",
      l.quantity,
      l.costBasis,
    ].join("|");
    closedLots.push({
      conid: l.conid,
      symbol: l.symbol,
      currency: l.currency,
      fx_rate_to_base: l.fxRateToBase,
      open_date_time: l.openDateTime,
      close_date: l.closeDate,
      closing_trade_id: l.closingTradeId,
      quantity: l.quantity,
      cost_basis: l.costBasis,
      proceeds: l.proceeds,
      fifo_pnl_realized: l.fifoPnlRealized,
      dedupe_hash: await sha256Hex(`${base}|#${nth(`lot|${base}`)}`),
    });
  }

  const cash = [];
  for (const t of s.cashTransactions) {
    const base = [
      userId,
      t.typeRaw,
      t.occurredAt,
      t.amount,
      t.currency,
      t.conid ?? "",
      t.tradeId ?? "",
      t.code ?? "",
      t.description ?? "",
    ].join("|");
    cash.push({
      occurred_at: t.occurredAt,
      report_date: t.reportDate,
      currency: t.currency,
      fx_rate_to_base: t.fxRateToBase,
      amount: t.amount,
      type_raw: t.typeRaw,
      category: t.category,
      conid: t.conid,
      isin: t.isin,
      symbol: t.symbol,
      description: t.description,
      trade_id: t.tradeId,
      code: t.code,
      dedupe_hash: await sha256Hex(`${base}|#${nth(`cash|${base}`)}`),
    });
  }

  const corporateActions = [];
  for (const a of [...s.corporateActions, ...s.transfers]) {
    const base = [
      userId,
      a.kind,
      a.occurredAt ?? "",
      a.conid ?? "",
      a.typeRaw ?? "",
      a.quantity ?? "",
      a.amount ?? "",
      a.code ?? "",
    ].join("|");
    corporateActions.push({
      kind: a.kind,
      occurred_at: a.occurredAt,
      conid: a.conid,
      symbol: a.symbol,
      type_raw: a.typeRaw,
      quantity: a.quantity,
      amount: a.amount,
      currency: a.currency,
      code: a.code,
      dedupe_hash: await sha256Hex(`${base}|#${nth(`corp|${base}`)}`),
    });
  }

  const fx = lastWins(s.fxRates, (r) => `${r.rateDate}|${r.fromCcy}|${r.toCcy}`).map((r) => ({
    rate_date: r.rateDate,
    from_ccy: r.fromCcy,
    to_ccy: r.toCcy,
    rate: r.rate,
  }));
  const nav = lastWins(s.nav, (n) => n.reportDate).map((n) => ({
    report_date: n.reportDate,
    currency: n.currency,
    cash: n.cash,
    stock: n.stock,
    other: n.other,
    total: n.total,
  }));

  return {
    meta: {
      report_date: snap.reportDate,
      statement_from: s.fromDate,
      statement_to: s.toDate,
      account_id_masked: maskAccountId(s.accountId),
      base_currency: s.baseCurrency,
      account_type: s.accountType,
    },
    positions,
    trades,
    closed_lots: closedLots,
    cash,
    fx,
    nav,
    corporate_actions: corporateActions,
  };
}

export type IngestPayload = Awaited<ReturnType<typeof toIngestPayload>>;
