// Portfolio and analytics arithmetic (spec 4.9). Pure: no I/O, no clock. Inputs are rows already parsed from Flex (spec 12).
import { dayNumber } from "./calendar.ts";

export type Money =
  | { kind: "ok"; value: number; ccy: string }
  | { kind: "unavailable"; reason: string };
/** Value of 1 unit of `from` in `to`. */
export interface FxRate {
  rate: number;
  rateDate: string;
  source: "flex" | "yahoo" | "frankfurter";
}
export interface Position {
  conid: number;
  ccy: string;
  qty: number;
  multiplier: number;
  costBasisMoney: number;
  markPrice: number | null;
  fifoUnrealized: number | null;
  fxToBase: number | null;
}
export interface ClosedLot {
  conid: number;
  ccy: string;
  qty: number;
  costBasis: number;
  proceeds: number;
  realizedPnl: number;
  closeDate: string;
  fxToBase: number | null;
  /** Optional identity (the database dedupe hash): a repeated key is counted once. */
  key?: string;
}
export interface CashTx {
  date: string;
  ccy: string;
  amount: number;
  category: "dividend" | "withholding_tax" | "interest" | "fee" | "deposit_withdrawal" | "other";
  conid: number | null;
  fxToBase: number | null;
}

export const ok = (value: number, ccy: string): Money => ({ kind: "ok", value, ccy });
export const unavailable = (reason: string): Money => ({ kind: "unavailable", reason });

export const RECONCILE_ABS = 0.01;
export const RECONCILE_REL = 1e-6;

/** costBasisMoney / (qty * multiplier); null when the quantity is zero. Equals the Flex `costBasisPrice`. */
export function averageCostPerUnit(p: Position): number | null {
  const units = p.qty * p.multiplier;
  return units === 0 ? null : p.costBasisMoney / units;
}

export function marketValue(p: Position, price: number): number {
  return p.qty * p.multiplier * price;
}

/** value minus cost: positive when the value exceeds the cost (never cost minus value). */
export function unrealizedPnl(p: Position, price: number): number {
  return marketValue(p, price) - p.costBasisMoney;
}

/** Preferred over `marketValue`: a missing or non-finite mark price is `unavailable` instead of NaN. */
export function marketValueMoney(p: Position, price: number | null): Money {
  if (price === null || !Number.isFinite(price)) return unavailable("Mark price unavailable");
  const v = marketValue(p, price);
  return Number.isFinite(v) ? ok(v, p.ccy) : unavailable("Market value is not a number");
}

/** Preferred over `unrealizedPnl`: a missing or non-finite mark price is `unavailable` instead of NaN. */
export function unrealizedMoney(p: Position, price: number | null): Money {
  if (price === null || !Number.isFinite(price)) return unavailable("Mark price unavailable");
  const v = unrealizedPnl(p, price);
  return Number.isFinite(v) ? ok(v, p.ccy) : unavailable("Unrealized P/L is not a number");
}

export function canReconcile(p: Position): boolean {
  return (
    p.markPrice !== null &&
    p.fifoUnrealized !== null &&
    Number.isFinite(p.markPrice) &&
    Number.isFinite(p.fifoUnrealized)
  );
}

/** Compares qty * mult * markPrice - cost with the Flex FIFO value. `diff` is signed (calculated minus broker); NaN when an input is missing. */
export function reconcileUnrealized(p: Position): { diff: number; withinTolerance: boolean } {
  if (!canReconcile(p)) return { diff: Number.NaN, withinTolerance: false };
  const calculated = (p.markPrice as number) * p.qty * p.multiplier - p.costBasisMoney;
  const diff = calculated - (p.fifoUnrealized as number);
  return {
    diff,
    withinTolerance: Math.abs(diff) <= RECONCILE_ABS + RECONCILE_REL * Math.abs(p.costBasisMoney),
  };
}

export function convertMoney(amount: number, from: string, to: string, fx: FxRate | null): Money {
  if (!Number.isFinite(amount)) return unavailable("Amount is not a number");
  if (from === to) return ok(amount, to);
  if (fx === null) return unavailable(`Missing FX rate ${from}->${to}`);
  if (!Number.isFinite(fx.rate) || fx.rate <= 0)
    return unavailable(`Invalid FX rate ${from}->${to}`);
  return ok(amount * fx.rate, to);
}

/**
 * Sum of amounts that are already in one currency. Any unavailable item makes the sum unavailable unless `partial` is set (the caller
 * then reports what was left out, see sumInBasePartial). Mixed currencies are never added. `ccy` names the currency of an empty sum.
 */
export function sumInBase(
  items: readonly Money[],
  opts: { partial?: boolean; ccy?: string } = {},
): Money {
  const oks: Array<Extract<Money, { kind: "ok" }>> = [];
  let firstBad: string | null = null;
  for (const item of items) {
    if (item.kind === "ok") oks.push(item);
    else firstBad ??= item.reason;
  }
  if (firstBad !== null && opts.partial !== true) return unavailable(firstBad);
  if (oks.length === 0) {
    if (items.length === 0 && opts.ccy !== undefined) return ok(0, opts.ccy);
    return unavailable(firstBad ?? "Nothing to sum");
  }
  const ccy = (oks[0] as Extract<Money, { kind: "ok" }>).ccy;
  if (oks.some((m) => m.ccy !== ccy)) return unavailable("Mixed currencies in sum");
  let total = 0;
  for (const m of oks) total += m.value;
  return ok(total, ccy);
}

export function sumInBasePartial(
  items: readonly Money[],
  ccy?: string,
): { total: Money; excluded: number; reasons: string[] } {
  const reasons = items
    .filter((m): m is Extract<Money, { kind: "unavailable" }> => m.kind === "unavailable")
    .map((m) => m.reason);
  return {
    total: sumInBase(items, ccy === undefined ? { partial: true } : { partial: true, ccy }),
    excluded: reasons.length,
    reasons,
  };
}

const rowRate = (fx: number | null, date: string): FxRate | null =>
  fx === null ? null : { rate: fx, rateDate: date, source: "flex" };

/** Sums `realizedPnl` of closed lots (partial sales appear as separate lots). Commissions are already netted by IBKR and are NOT subtracted again. */
export function realizedSummary(
  lots: readonly ClosedLot[],
  base: string,
): { realizedBase: Money; byCcy: Record<string, number>; lotCount: number } {
  const seen = new Set<string>();
  const byCcy: Record<string, number> = {};
  const items: Money[] = [];
  let lotCount = 0;
  for (const lot of lots) {
    if (lot.key !== undefined) {
      if (seen.has(lot.key)) continue;
      seen.add(lot.key);
    }
    lotCount += 1;
    byCcy[lot.ccy] = (byCcy[lot.ccy] ?? 0) + lot.realizedPnl;
    items.push(convertMoney(lot.realizedPnl, lot.ccy, base, rowRate(lot.fxToBase, lot.closeDate)));
  }
  return { realizedBase: sumInBase(items, { ccy: base }), byCcy, lotCount };
}

/** Gross = dividend rows, withholding = withholding-tax rows (negative amounts), net = gross + withholding. */
export function dividendSummary(
  tx: readonly CashTx[],
  base: string,
): { grossBase: Money; withholdingBase: Money; netBase: Money } {
  const convert = (rows: readonly CashTx[]): Money =>
    sumInBase(
      rows.map((r) => convertMoney(r.amount, r.ccy, base, rowRate(r.fxToBase, r.date))),
      { ccy: base },
    );
  const grossBase = convert(tx.filter((t) => t.category === "dividend"));
  const withholdingBase = convert(tx.filter((t) => t.category === "withholding_tax"));
  return {
    grossBase,
    withholdingBase,
    netBase: sumInBase([grossBase, withholdingBase], { ccy: base }),
  };
}

/** Flex reports commissions as negative numbers; the result is the total cost (positive). `fxToBase` is the rate of the COMMISSION currency. */
export function commissionSummary(
  trades: readonly { commission: number; ccy: string; fxToBase: number | null }[],
  base: string,
): Money {
  return sumInBase(
    trades.map((t) => convertMoney(-t.commission, t.ccy, base, rowRate(t.fxToBase, ""))),
    { ccy: base },
  );
}

/** Fees and interest from Cash Transactions as a net cost (positive = money out). They are NOT inside the Flex realized P/L. */
export function otherCostsSummary(tx: readonly CashTx[], base: string): Money {
  return sumInBase(
    tx
      .filter((t) => t.category === "fee" || t.category === "interest")
      .map((t) => convertMoney(-t.amount, t.ccy, base, rowRate(t.fxToBase, t.date))),
    { ccy: base },
  );
}

/** qty * multiplier * (last - previous close), in the position currency; both prices must already be in that currency. Labelled "estimated". */
export function dailyPnlEstimate(p: Position, last: number, prevClose: number | null): Money {
  if (prevClose === null || !Number.isFinite(prevClose) || !Number.isFinite(last))
    return unavailable("Previous close unavailable");
  return ok(p.qty * p.multiplier * (last - prevClose), p.ccy);
}

export function combinedPerformance(a: {
  realized: Money;
  unrealized: Money;
  dividendsNet: Money;
  includeDividends: boolean;
}): Money {
  return sumInBase(
    a.includeDividends ? [a.realized, a.unrealized, a.dividendsNet] : [a.realized, a.unrealized],
  );
}

/** Combined performance minus the other-costs memo (fees and interest), shown as a separate "after other costs" line. */
export function afterOtherCosts(combined: Money, otherCosts: Money): Money {
  if (combined.kind === "unavailable") return combined;
  if (otherCosts.kind === "unavailable") return otherCosts;
  if (combined.ccy !== otherCosts.ccy) return unavailable("Mixed currencies in sum");
  return ok(combined.value - otherCosts.value, combined.ccy);
}

export interface FlexRateRow {
  rateDate: string;
  fromCcy: string;
  toCcy: string;
  rate: number;
}

const dayOf = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return dayNumber(y as number, m as number, d as number);
};

/**
 * Flex Currency Conversion Rate for `from` -> `to`: the exact date, else the latest rate dated BEFORE it within `maxAgeDays`;
 * the inverse of the opposite pair is used when only that exists. Never a rate from the future.
 */
export function flexRateFor(
  rates: readonly FlexRateRow[],
  from: string,
  to: string,
  date: string,
  maxAgeDays = 5,
): FxRate | null {
  if (from === to) return { rate: 1, rateDate: date, source: "flex" };
  const target = dayOf(date);
  const best = (a: string, b: string): FlexRateRow | null => {
    let found: FlexRateRow | null = null;
    for (const r of rates) {
      if (r.fromCcy !== a || r.toCcy !== b) continue;
      const age = target - dayOf(r.rateDate);
      if (Number.isNaN(age) || age < 0 || age > maxAgeDays) continue;
      if (found === null || r.rateDate > found.rateDate) found = r;
    }
    return found;
  };
  const direct = best(from, to);
  if (direct !== null) return { rate: direct.rate, rateDate: direct.rateDate, source: "flex" };
  const inverse = best(to, from);
  if (inverse !== null && inverse.rate > 0)
    return { rate: 1 / inverse.rate, rateDate: inverse.rateDate, source: "flex" };
  return null;
}

export interface NavPoint {
  date: string;
  total: number;
  ccy: string;
}
export interface PerformancePoint {
  date: string;
  nav: number;
  netFlows: number;
  performance: number;
}

/** NAV minus cumulative net deposits/withdrawals after the first NAV date (spec 12.9). Unavailable when flows are missing or unvalued. */
export function performanceSeries(
  nav: readonly NavPoint[],
  flows: readonly CashTx[],
  base: string,
  o: { flowsComplete: boolean },
): { kind: "ok"; points: PerformancePoint[] } | { kind: "unavailable"; reason: string } {
  if (!o.flowsComplete)
    return { kind: "unavailable", reason: "Transfers or other flows are not valued" };
  const sorted = [...nav].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length < 2) return { kind: "unavailable", reason: "Fewer than two NAV rows" };
  if (sorted.some((n) => n.ccy !== base))
    return { kind: "unavailable", reason: "NAV is not in the base currency" };
  const first = sorted[0] as NavPoint;
  const deposits = flows.filter((f) => f.category === "deposit_withdrawal" && f.date > first.date);
  const converted = deposits.map((f) => ({
    date: f.date,
    m: convertMoney(f.amount, f.ccy, base, rowRate(f.fxToBase, f.date)),
  }));
  const bad = converted.find((c) => c.m.kind === "unavailable");
  if (bad !== undefined && bad.m.kind === "unavailable")
    return { kind: "unavailable", reason: bad.m.reason };
  const points = sorted.map((n) => {
    let netFlows = 0;
    for (const c of converted) if (c.date <= n.date && c.m.kind === "ok") netFlows += c.m.value;
    return { date: n.date, nav: n.total, netFlows, performance: n.total - first.total - netFlows };
  });
  return { kind: "ok", points };
}
