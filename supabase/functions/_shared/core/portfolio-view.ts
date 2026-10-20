// Valuation of the latest Flex snapshot with delayed quotes (spec 12.8). Pure: quotes and FX arrive as data.
import {
  averageCostPerUnit,
  canReconcile,
  convertMoney,
  dailyPnlEstimate,
  type FxRate,
  type Money,
  ok,
  type Position,
  reconcileUnrealized,
  sumInBasePartial,
  unavailable,
  unrealizedPnl,
} from "./accounting.ts";
import type { StatementFreshness } from "./statement-day.ts";
import { resolveCurrency } from "./units.ts";

export type { FxRate, Money } from "./accounting.ts";

export type ValuationTag = "discounted" | "premium" | "extra_premium" | "unavailable" | "none";

/** One row of the latest broker_positions snapshot joined with its valuation symbol. */
export interface HeldPosition {
  id: number;
  conid: number;
  symbol: string;
  description: string | null;
  assetClass: string | null;
  currency: string;
  quantity: number;
  multiplier: number;
  costBasisMoney: number | null;
  costBasisPrice: number | null;
  markPrice: number | null;
  fifoPnlUnrealized: number | null;
  fxRateToBase: number | null;
  reportDate: string;
  valuationSymbol: string | null;
  valuationTag: string | null;
  valuationSessionDate: string | null;
  valuationReason: string | null;
  matchStatus: string;
}

export interface QuoteInfo {
  symbol: string;
  price: number | null;
  /** as quoted by Yahoo: GBp, ZAc, ILA, KWF are minor units */
  currency: string;
  changePercent: number | null;
  regularMarketTime: number | null;
  marketState: string | null;
  fetchedAtMs: number;
}

export type PriceSource =
  | {
      kind: "delayed_quote";
      asOfMs: number | null;
      marketState: string | null;
      fetchedAtMs: number;
    }
  | { kind: "statement_close"; reportDate: string; reason: string }
  | { kind: "unavailable"; reason: string };

export interface PositionView {
  id: number;
  conid: number;
  ticker: string;
  name: string | null;
  assetClass: string | null;
  currency: string;
  quantity: number;
  multiplier: number;
  price: { value: number | null; ccy: string; source: PriceSource; note: string | null };
  quoteTime: string | null;
  costBasis: Money;
  marketValue: Money;
  averageCost: number | null;
  dailyPnl: Money;
  unrealizedIndependent: Money;
  unrealizedBroker: number | null;
  /** true: Flex FIFO value agrees with the statement mark; false: "does not reconcile"; null: not comparable */
  reconciles: boolean | null;
  valueBase: Money;
  costBase: Money;
  unrealizedBase: Money;
  dailyBase: Money;
  fxSource: "base" | "yahoo" | "flex" | "unavailable";
  fxDate: string | null;
  tag: ValuationTag;
  tagBasis: string | null;
  matchStatus: string;
}

export interface CurrencyBreakdown {
  ccy: string;
  count: number;
  excluded: number;
  cost: Money;
  value: Money;
  unrealized: Money;
  daily: Money;
}

export interface PortfolioTotals {
  costBase: Money;
  valueBase: Money;
  unrealizedBase: Money;
  dailyBase: Money;
  included: number;
  excluded: Array<{ symbol: string; reason: string }>;
  dailyExcluded: number;
}

export interface PortfolioView {
  baseCurrency: string;
  reportDate: string | null;
  positions: PositionView[];
  totals: PortfolioTotals;
  perCurrency: CurrencyBreakdown[];
  quotesFetchedAt: string | null;
}

/** The shape returned by the portfolio-refresh function and consumed by the SPA. */
export interface PortfolioResponse {
  serverTime: string;
  nextAutoRefreshAt: string;
  manualAvailableAt: string;
  lastSuccessfulAt: string | null;
  baseCurrency: string | null;
  reportDate: string | null;
  lastStatementDate: string | null;
  statement: { expectedDate: string; freshness: StatementFreshness };
  syncQueued: boolean;
  quoteError: string | null;
  view: PortfolioView;
}

export interface ViewInput {
  nowMs: number;
  baseCurrency: string;
  reportDate: string | null;
  lastStatementDate: string | null;
  positions: readonly HeldPosition[];
  quotes: ReadonlyMap<string, QuoteInfo>;
  /** current Yahoo rates, key `${from}>${to}` (value of 1 `from` in `to`) */
  fx: ReadonlyMap<string, FxRate>;
}

export const fxKey = (from: string, to: string): string => `${from}>${to}`;

/** Only the newest report date is a current snapshot; older rows are history and are never valued. */
export function selectLatestSnapshot<T extends { reportDate: string }>(rows: readonly T[]): T[] {
  let latest = "";
  for (const r of rows) if (r.reportDate > latest) latest = r.reportDate;
  return rows.filter((r) => r.reportDate === latest);
}

export function neededFxPairs(
  positions: readonly HeldPosition[],
  quotes: ReadonlyMap<string, QuoteInfo>,
  base: string,
): Array<{ from: string; to: string }> {
  const pairs = new Map<string, { from: string; to: string }>();
  const add = (from: string, to: string) => {
    if (from !== to) pairs.set(fxKey(from, to), { from, to });
  };
  for (const p of positions) {
    add(p.currency, base);
    const q = p.valuationSymbol === null ? undefined : quotes.get(p.valuationSymbol);
    if (q !== undefined) add(resolveCurrency(q.currency).major, p.currency);
  }
  return [...pairs.values()];
}

const UNIT_RATIO = { low: 80, high: 120 };

function quotePrice(
  p: HeldPosition,
  q: QuoteInfo | undefined,
  fx: ReadonlyMap<string, FxRate>,
): { price: number; note: string | null } | { reason: string } {
  if (q === undefined || q.price === null || !Number.isFinite(q.price) || q.price <= 0)
    return { reason: "no delayed quote" };
  const unit = resolveCurrency(q.currency);
  let price = q.price / unit.divisor;
  let note: string | null =
    unit.divisor === 1 ? null : `quoted in ${q.currency}, converted to ${unit.major}`;
  if (unit.major !== p.currency) {
    const converted = convertMoney(
      price,
      unit.major,
      p.currency,
      fx.get(fxKey(unit.major, p.currency)) ?? null,
    );
    if (converted.kind === "unavailable") return { reason: converted.reason };
    price = converted.value;
    note = `quote converted from ${unit.major} to ${p.currency}`;
  }
  if (p.markPrice !== null && p.markPrice > 0) {
    const ratio = price / p.markPrice;
    if (
      (ratio > UNIT_RATIO.low && ratio < UNIT_RATIO.high) ||
      (ratio > 1 / UNIT_RATIO.high && ratio < 1 / UNIT_RATIO.low)
    ) {
      return { reason: "price unit mismatch (pence versus pounds), delayed quote rejected" };
    }
  }
  return { price, note };
}

function baseRate(
  p: HeldPosition,
  base: string,
  fx: ReadonlyMap<string, FxRate>,
): { rate: FxRate | null; source: PositionView["fxSource"]; date: string | null } {
  if (p.currency === base)
    return {
      rate: { rate: 1, rateDate: p.reportDate, source: "flex" },
      source: "base",
      date: null,
    };
  const live = fx.get(fxKey(p.currency, base));
  if (live !== undefined) return { rate: live, source: "yahoo", date: live.rateDate };
  if (p.fxRateToBase !== null)
    return {
      rate: { rate: p.fxRateToBase, rateDate: p.reportDate, source: "flex" },
      source: "flex",
      date: p.reportDate,
    };
  return { rate: null, source: "unavailable", date: null };
}

const TAGS: readonly ValuationTag[] = [
  "discounted",
  "premium",
  "extra_premium",
  "unavailable",
  "none",
];

export function buildPortfolioView(input: ViewInput): PortfolioView {
  const base = input.baseCurrency;
  const rows: PositionView[] = input.positions.map((p) => {
    const q = p.valuationSymbol === null ? undefined : input.quotes.get(p.valuationSymbol);
    const qp = quotePrice(p, q, input.fx);
    let priceValue: number | null = null;
    let source: PriceSource;
    let note: string | null = null;
    if ("price" in qp && q !== undefined) {
      priceValue = qp.price;
      note = qp.note;
      source = {
        kind: "delayed_quote",
        asOfMs: q.regularMarketTime,
        marketState: q.marketState,
        fetchedAtMs: q.fetchedAtMs,
      };
    } else if (p.markPrice !== null) {
      priceValue = p.markPrice;
      source = {
        kind: "statement_close",
        reportDate: p.reportDate,
        reason: "reason" in qp ? qp.reason : "no delayed quote",
      };
    } else {
      source = { kind: "unavailable", reason: "reason" in qp ? qp.reason : "no delayed quote" };
    }

    const acc: Position | null =
      p.costBasisMoney === null
        ? null
        : {
            conid: p.conid,
            ccy: p.currency,
            qty: p.quantity,
            multiplier: p.multiplier,
            costBasisMoney: p.costBasisMoney,
            markPrice: p.markPrice,
            fifoUnrealized: p.fifoPnlUnrealized,
            fxToBase: p.fxRateToBase,
          };
    const priceReason = source.kind === "unavailable" ? source.reason : "price unavailable";
    const costBasis: Money =
      p.costBasisMoney === null
        ? unavailable("Cost basis missing in the statement")
        : ok(p.costBasisMoney, p.currency);
    const marketValue: Money =
      priceValue === null
        ? unavailable(priceReason)
        : ok(p.quantity * p.multiplier * priceValue, p.currency);
    const unrealized: Money =
      acc === null
        ? unavailable("Cost basis missing in the statement")
        : priceValue === null
          ? unavailable(priceReason)
          : ok(unrealizedPnl(acc, priceValue), p.currency);

    let daily: Money = unavailable("Daily change needs a delayed quote");
    if (source.kind === "delayed_quote" && priceValue !== null && acc !== null) {
      const pct = q?.changePercent ?? null;
      daily =
        pct === null || pct <= -100
          ? unavailable("Daily change unavailable")
          : dailyPnlEstimate(acc, priceValue, priceValue / (1 + pct / 100));
    }

    const rate = baseRate(p, base, input.fx);
    const toBase = (m: Money): Money =>
      m.kind === "ok" ? convertMoney(m.value, m.ccy, base, rate.rate) : m;

    const tag: ValuationTag =
      p.valuationTag !== null && (TAGS as readonly string[]).includes(p.valuationTag)
        ? (p.valuationTag as ValuationTag)
        : "unavailable";
    return {
      id: p.id,
      conid: p.conid,
      ticker: p.symbol,
      name: p.description,
      assetClass: p.assetClass,
      currency: p.currency,
      quantity: p.quantity,
      multiplier: p.multiplier,
      price: { value: priceValue, ccy: p.currency, source, note },
      quoteTime:
        source.kind === "delayed_quote" && source.asOfMs !== null
          ? new Date(source.asOfMs).toISOString()
          : null,
      costBasis,
      marketValue,
      averageCost: acc === null ? null : averageCostPerUnit(acc),
      dailyPnl: daily,
      unrealizedIndependent: unrealized,
      unrealizedBroker: p.fifoPnlUnrealized,
      reconciles:
        acc === null || !canReconcile(acc) ? null : reconcileUnrealized(acc).withinTolerance,
      valueBase: toBase(marketValue),
      costBase: toBase(costBasis),
      unrealizedBase: toBase(unrealized),
      dailyBase: toBase(daily),
      fxSource: rate.source,
      fxDate: rate.date,
      tag,
      tagBasis: p.valuationTag === null ? "not evaluated yet" : p.valuationReason,
      matchStatus: p.matchStatus,
    };
  });

  // base totals: only positions whose cost AND value convert, so that value - cost = unrealized holds exactly
  const excluded: Array<{ symbol: string; reason: string }> = [];
  const usable = rows.filter((r) => {
    const bad = [r.costBase, r.valueBase].find(
      (m): m is Extract<Money, { kind: "unavailable" }> => m.kind === "unavailable",
    );
    if (bad === undefined) return true;
    excluded.push({ symbol: r.ticker, reason: bad.reason });
    return false;
  });
  // when positions exist but none converts, the totals are unavailable (never a silent zero)
  const nothingUsable = rows.length > 0 && usable.length === 0;
  const noTotal = {
    total: unavailable(excluded[0]?.reason ?? "No position could be valued"),
    excluded: 0,
    reasons: [] as string[],
  };
  const sum = (pick: (r: PositionView) => Money) =>
    nothingUsable ? noTotal : sumInBasePartial(usable.map(pick), base);
  const daily = sum((r) => r.dailyBase);

  const byCcy = new Map<string, PositionView[]>();
  for (const r of rows) byCcy.set(r.currency, [...(byCcy.get(r.currency) ?? []), r]);
  const perCurrency: CurrencyBreakdown[] = [...byCcy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ccy, list]) => {
      const complete = list.filter((r) => r.costBasis.kind === "ok" && r.marketValue.kind === "ok");
      const native = (pick: (r: PositionView) => Money) =>
        sumInBasePartial(complete.map(pick), ccy).total;
      return {
        ccy,
        count: complete.length,
        excluded: list.length - complete.length,
        cost: native((r) => r.costBasis),
        value: native((r) => r.marketValue),
        unrealized: native((r) => r.unrealizedIndependent),
        daily: native((r) => r.dailyPnl),
      };
    });

  const fetched = [...input.quotes.values()].map((q) => q.fetchedAtMs);
  return {
    baseCurrency: base,
    reportDate: input.reportDate,
    positions: rows,
    totals: {
      costBase: sum((r) => r.costBase).total,
      valueBase: sum((r) => r.valueBase).total,
      unrealizedBase: sum((r) => r.unrealizedBase).total,
      dailyBase: daily.total,
      included: usable.length,
      excluded,
      dailyExcluded: daily.excluded,
    },
    perCurrency,
    quotesFetchedAt: fetched.length === 0 ? null : new Date(Math.max(...fetched)).toISOString(),
  };
}
