import { describe, expect, it } from "vitest";
import {
  afterOtherCosts,
  averageCostPerUnit,
  type CashTx,
  type ClosedLot,
  canReconcile,
  combinedPerformance,
  commissionSummary,
  convertMoney,
  dailyPnlEstimate,
  dividendSummary,
  type FxRate,
  flexRateFor,
  type Money,
  marketValue,
  marketValueMoney,
  ok,
  otherCostsSummary,
  type Position,
  performanceSeries,
  realizedSummary,
  reconcileUnrealized,
  sumInBase,
  sumInBasePartial,
  unavailable,
  unrealizedMoney,
  unrealizedPnl,
} from "./accounting.ts";

const pos = (o: Partial<Position> = {}): Position => ({
  conid: 100001,
  ccy: "USD",
  qty: 10,
  multiplier: 1,
  costBasisMoney: 2001.7,
  markPrice: 230,
  fifoUnrealized: 298.3,
  fxToBase: 0.92,
  ...o,
});

const flex = (rate: number, rateDate = "2026-10-14"): FxRate => ({
  rate,
  rateDate,
  source: "flex",
});

function value(m: Money): number {
  if (m.kind !== "ok") throw new Error(`expected ok, got unavailable: ${m.reason}`);
  return m.value;
}

describe("average cost, market value, unrealized P&L", () => {
  it("average cost per unit is cost basis money over quantity times multiplier", () => {
    expect(averageCostPerUnit(pos())).toBeCloseTo(200.17, 10);
    expect(averageCostPerUnit(pos({ qty: 0 }))).toBeNull();
    expect(averageCostPerUnit(pos({ qty: 2, multiplier: 100, costBasisMoney: 4000 }))).toBe(20);
    expect(averageCostPerUnit(pos({ qty: -10, costBasisMoney: -2000 }))).toBe(200);
  });

  it("market value is qty * multiplier * price", () => {
    expect(marketValue(pos(), 230)).toBe(2300);
    expect(marketValue(pos({ qty: 2, multiplier: 100 }), 5.5)).toBe(1100);
  });

  it("unrealized P&L is value minus cost: positive when value exceeds cost, never cost minus value", () => {
    expect(unrealizedPnl(pos(), 230)).toBeCloseTo(298.3, 10);
    expect(unrealizedPnl(pos(), 150)).toBeCloseTo(-501.7, 10);
    expect(unrealizedPnl(pos({ qty: -10, costBasisMoney: -2000 }), 190)).toBeCloseTo(100, 10); // short: price fell, gain
    expect(unrealizedPnl(pos({ qty: -10, costBasisMoney: -2000 }), 210)).toBeCloseTo(-100, 10);
  });
});

describe("reconciliation against the Flex FIFO unrealized value", () => {
  it("agrees within 0.01 + 1e-6 * |cost|", () => {
    expect(reconcileUnrealized(pos()).withinTolerance).toBe(true);
    expect(reconcileUnrealized(pos({ fifoUnrealized: 298.305 })).withinTolerance).toBe(true);
    expect(reconcileUnrealized(pos({ fifoUnrealized: 298.32 })).withinTolerance).toBe(false);
    const big = pos({
      qty: 1000,
      costBasisMoney: 1_000_000,
      markPrice: 1000.5,
      fifoUnrealized: 500,
    });
    expect(reconcileUnrealized(big).diff).toBe(0);
    expect(reconcileUnrealized({ ...big, fifoUnrealized: 500.9 }).withinTolerance).toBe(true); // 0.9 <= 0.01 + 1
    expect(reconcileUnrealized({ ...big, fifoUnrealized: 502 }).withinTolerance).toBe(false);
  });

  it("reports the signed difference and flags missing inputs as not comparable", () => {
    expect(reconcileUnrealized(pos({ fifoUnrealized: 290 })).diff).toBeCloseTo(8.3, 10);
    const missing = reconcileUnrealized(pos({ markPrice: null }));
    expect(Number.isNaN(missing.diff)).toBe(true);
    expect(missing.withinTolerance).toBe(false);
    expect(canReconcile(pos())).toBe(true);
    expect(canReconcile(pos({ fifoUnrealized: null }))).toBe(false);
  });
});

describe("convertMoney and sumInBase", () => {
  it("same currency needs no rate; a rate converts; a missing or invalid rate is unavailable with a reason", () => {
    expect(convertMoney(10, "EUR", "EUR", null)).toEqual(ok(10, "EUR"));
    expect(value(convertMoney(10, "USD", "EUR", flex(0.92)))).toBeCloseTo(9.2, 10);
    const missing = convertMoney(10, "USD", "EUR", null);
    expect(missing.kind).toBe("unavailable");
    if (missing.kind === "unavailable") expect(missing.reason).toContain("USD->EUR");
    expect(convertMoney(10, "USD", "EUR", flex(0)).kind).toBe("unavailable");
    expect(convertMoney(10, "USD", "EUR", flex(Number.NaN)).kind).toBe("unavailable");
  });

  it("an unavailable item makes the sum unavailable unless the caller asks for a partial sum", () => {
    const items = [ok(1, "EUR"), unavailable("no fx"), ok(2, "EUR")];
    expect(sumInBase(items)).toEqual(unavailable("no fx"));
    expect(sumInBase(items, { partial: true })).toEqual(ok(3, "EUR"));
    expect(sumInBase([ok(1, "EUR"), ok(2.5, "EUR")])).toEqual(ok(3.5, "EUR"));
  });

  it("never sums mixed currencies and handles the empty list explicitly", () => {
    expect(sumInBase([ok(1, "EUR"), ok(1, "USD")]).kind).toBe("unavailable");
    expect(sumInBase([], { ccy: "EUR" })).toEqual(ok(0, "EUR"));
    expect(sumInBase([]).kind).toBe("unavailable");
    expect(sumInBase([unavailable("x")], { partial: true }).kind).toBe("unavailable");
  });

  it("sumInBasePartial reports what was left out", () => {
    const r = sumInBasePartial([ok(1, "EUR"), unavailable("a"), ok(2, "EUR"), unavailable("b")]);
    expect(r.total).toEqual(ok(3, "EUR"));
    expect(r.excluded).toBe(2);
    expect(r.reasons).toEqual(["a", "b"]);
    expect(sumInBasePartial([unavailable("a")]).total.kind).toBe("unavailable");
  });
});

describe("realized P&L over closed lots (partial sales, no double counting)", () => {
  const lotA: ClosedLot = {
    conid: 100002,
    ccy: "GBP",
    qty: 3,
    costBasis: 75,
    proceeds: 79.5,
    realizedPnl: 4.2,
    closeDate: "2026-10-08",
    fxToBase: 1.15,
    key: "a",
  };
  const lotB: ClosedLot = {
    conid: 100002,
    ccy: "GBP",
    qty: 1,
    costBasis: 26,
    proceeds: 26.5,
    realizedPnl: 0.4,
    closeDate: "2026-10-08",
    fxToBase: 1.15,
    key: "b",
  };

  it("the lots of one partial sale add up to the execution P/L (4.60) and convert with each row's rate", () => {
    const r = realizedSummary([lotA, lotB], "EUR");
    expect(r.lotCount).toBe(2);
    expect(r.byCcy["GBP"]).toBeCloseTo(4.6, 10);
    expect(value(r.realizedBase)).toBeCloseTo(4.6 * 1.15, 10);
  });

  it("a lot that arrives twice (overlapping statements) is counted once", () => {
    const r = realizedSummary([lotA, lotB, { ...lotA }], "EUR");
    expect(r.lotCount).toBe(2);
    expect(r.byCcy["GBP"]).toBeCloseTo(4.6, 10);
  });

  it("losses and gains are both included; the sign is the broker's", () => {
    const loss: ClosedLot = { ...lotA, key: "c", realizedPnl: -10 };
    expect(realizedSummary([lotA, loss], "GBP").byCcy["GBP"]).toBeCloseTo(-5.8, 10);
  });

  it("a lot in the base currency needs no rate; a missing rate makes the base figure unavailable but keeps the native sums", () => {
    const eur: ClosedLot = { ...lotA, ccy: "EUR", fxToBase: null, key: "e" };
    expect(value(realizedSummary([eur], "EUR").realizedBase)).toBeCloseTo(4.2, 10);
    const noRate = realizedSummary([{ ...lotA, fxToBase: null }, lotB], "EUR");
    expect(noRate.realizedBase.kind).toBe("unavailable");
    expect(noRate.byCcy["GBP"]).toBeCloseTo(4.6, 10);
  });

  it("no lots is a real zero in the base currency", () => {
    expect(realizedSummary([], "EUR")).toEqual({
      realizedBase: ok(0, "EUR"),
      byCcy: {},
      lotCount: 0,
    });
  });
});

describe("dividends gross, withholding, net", () => {
  const tx = (o: Partial<CashTx>): CashTx => ({
    date: "2026-10-10",
    ccy: "USD",
    amount: 0,
    category: "dividend",
    conid: 100001,
    fxToBase: 0.92,
    ...o,
  });

  it("gross and withholding are separate and net is their sum; other categories are excluded", () => {
    const r = dividendSummary(
      [
        tx({ amount: 2.6 }),
        tx({ amount: -0.39, category: "withholding_tax" }),
        tx({ amount: 5000, category: "deposit_withdrawal", ccy: "EUR", fxToBase: 1 }),
        tx({ amount: -2, category: "fee", ccy: "EUR", fxToBase: 1 }),
      ],
      "EUR",
    );
    expect(value(r.grossBase)).toBeCloseTo(2.392, 10);
    expect(value(r.withholdingBase)).toBeCloseTo(-0.3588, 10);
    expect(value(r.netBase)).toBeCloseTo(2.0332, 10);
  });

  it("a missing rate makes gross and net unavailable (never zero)", () => {
    const r = dividendSummary([tx({ amount: 2.6, fxToBase: null })], "EUR");
    expect(r.grossBase.kind).toBe("unavailable");
    expect(r.netBase.kind).toBe("unavailable");
    expect(value(r.withholdingBase)).toBe(0);
  });

  it("no dividend rows is a real zero", () => {
    expect(dividendSummary([], "EUR").netBase).toEqual(ok(0, "EUR"));
  });
});

describe("commissions and other costs", () => {
  it("commissionSummary returns the total cost as a positive number, converted per row", () => {
    const m = commissionSummary(
      [
        { commission: -1, ccy: "USD", fxToBase: 0.92 },
        { commission: -0.7, ccy: "USD", fxToBase: 0.92 },
        { commission: -0.4, ccy: "GBP", fxToBase: 1.15 },
      ],
      "EUR",
    );
    expect(value(m)).toBeCloseTo(1.7 * 0.92 + 0.4 * 1.15, 10);
  });

  it("a commission in a currency without a rate is unavailable; none is zero", () => {
    expect(commissionSummary([{ commission: -1, ccy: "USD", fxToBase: null }], "EUR").kind).toBe(
      "unavailable",
    );
    expect(commissionSummary([], "EUR")).toEqual(ok(0, "EUR"));
  });

  it("other costs are fees and interest (net outflow positive), outside realized P&L", () => {
    const tx = (o: Partial<CashTx>): CashTx => ({
      date: "2026-10-01",
      ccy: "EUR",
      amount: 0,
      category: "fee",
      conid: null,
      fxToBase: 1,
      ...o,
    });
    const m = otherCostsSummary(
      [
        tx({ amount: -2 }),
        tx({ amount: -1.5, category: "interest" }),
        tx({ amount: 0.5, category: "interest" }),
        tx({ amount: 9, category: "dividend" }),
      ],
      "EUR",
    );
    expect(value(m)).toBeCloseTo(3, 10);
  });
});

describe("daily P&L estimate", () => {
  it("is qty * multiplier * (last - previous close) in the position currency", () => {
    expect(dailyPnlEstimate(pos(), 230, 228)).toEqual(ok(20, "USD"));
    expect(dailyPnlEstimate(pos({ qty: 2, multiplier: 100 }), 5, 5.5)).toEqual(ok(-100, "USD"));
  });

  it("is unavailable without a previous close", () => {
    expect(dailyPnlEstimate(pos(), 230, null).kind).toBe("unavailable");
    expect(dailyPnlEstimate(pos(), 230, Number.NaN).kind).toBe("unavailable");
  });
});

describe("combined performance and the dividends toggle", () => {
  const realized = ok(100, "EUR");
  const unrealized = ok(50, "EUR");
  const dividends = ok(10, "EUR");

  it("excluding dividends is realized + unrealized; including adds net dividends", () => {
    expect(
      combinedPerformance({
        realized,
        unrealized,
        dividendsNet: dividends,
        includeDividends: false,
      }),
    ).toEqual(ok(150, "EUR"));
    expect(
      combinedPerformance({
        realized,
        unrealized,
        dividendsNet: dividends,
        includeDividends: true,
      }),
    ).toEqual(ok(160, "EUR"));
  });

  it("unavailable dividends only matter when they are included", () => {
    const missing = unavailable("no fx");
    expect(
      combinedPerformance({ realized, unrealized, dividendsNet: missing, includeDividends: false }),
    ).toEqual(ok(150, "EUR"));
    expect(
      combinedPerformance({ realized, unrealized, dividendsNet: missing, includeDividends: true })
        .kind,
    ).toBe("unavailable");
  });

  it("an unavailable realized or unrealized figure makes the combined figure unavailable", () => {
    expect(
      combinedPerformance({
        realized: unavailable("x"),
        unrealized,
        dividendsNet: dividends,
        includeDividends: false,
      }).kind,
    ).toBe("unavailable");
    expect(
      combinedPerformance({
        realized,
        unrealized: unavailable("y"),
        dividendsNet: dividends,
        includeDividends: true,
      }).kind,
    ).toBe("unavailable");
  });

  it("after other costs subtracts the cost memo once", () => {
    expect(afterOtherCosts(ok(150, "EUR"), ok(3, "EUR"))).toEqual(ok(147, "EUR"));
    expect(afterOtherCosts(ok(150, "EUR"), unavailable("z")).kind).toBe("unavailable");
    expect(afterOtherCosts(ok(150, "EUR"), ok(3, "USD")).kind).toBe("unavailable");
  });
});

describe("Flex conversion rates by date", () => {
  const rates = [
    { rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 },
    { rateDate: "2026-10-09", fromCcy: "GBP", toCcy: "EUR", rate: 1.14 },
  ];

  it("uses the exact date, else the latest earlier rate within five days, else nothing", () => {
    expect(flexRateFor(rates, "USD", "EUR", "2026-10-14")).toEqual({
      rate: 0.92,
      rateDate: "2026-10-14",
      source: "flex",
    });
    expect(flexRateFor(rates, "GBP", "EUR", "2026-10-13")).toEqual({
      rate: 1.14,
      rateDate: "2026-10-09",
      source: "flex",
    });
    expect(flexRateFor(rates, "GBP", "EUR", "2026-10-20")).toBeNull();
    expect(flexRateFor(rates, "CHF", "EUR", "2026-10-14")).toBeNull();
    expect(flexRateFor(rates, "EUR", "EUR", "2026-10-14")).toEqual({
      rate: 1,
      rateDate: "2026-10-14",
      source: "flex",
    });
  });

  it("uses the inverse of the opposite pair when only that one exists", () => {
    const r = flexRateFor(rates, "EUR", "USD", "2026-10-14");
    expect(r?.rate).toBeCloseTo(1 / 0.92, 10);
  });

  it("a rate dated after the requested day is never used", () => {
    expect(flexRateFor(rates, "USD", "EUR", "2026-10-13")).toBeNull();
  });
});

describe("performance series (NAV minus net deposits)", () => {
  const nav = [
    { date: "2026-10-01", total: 1000, ccy: "EUR" },
    { date: "2026-10-05", total: 1500, ccy: "EUR" },
    { date: "2026-10-10", total: 1520, ccy: "EUR" },
  ];
  const dep = (date: string, amount: number): CashTx => ({
    date,
    ccy: "EUR",
    amount,
    category: "deposit_withdrawal",
    conid: null,
    fxToBase: 1,
  });

  it("subtracts cumulative net flows after the first NAV date", () => {
    const r = performanceSeries(
      nav,
      [dep("2026-10-01", 999), dep("2026-10-03", 400), dep("2026-10-08", -100)],
      "EUR",
      { flowsComplete: true },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.points.map((p) => p.performance)).toEqual([0, 100, 220]);
      expect(r.points.map((p) => p.netFlows)).toEqual([0, 400, 300]);
    }
  });

  it("is unavailable when flows are incomplete, NAV is too short, or a flow has no rate", () => {
    expect(performanceSeries(nav, [], "EUR", { flowsComplete: false }).kind).toBe("unavailable");
    expect(performanceSeries(nav.slice(0, 1), [], "EUR", { flowsComplete: true }).kind).toBe(
      "unavailable",
    );
    expect(
      performanceSeries(nav, [{ ...dep("2026-10-03", 5), ccy: "USD", fxToBase: null }], "EUR", {
        flowsComplete: true,
      }).kind,
    ).toBe("unavailable");
  });
});

describe("Money variants and NaN-dated rates", () => {
  it("marketValueMoney and unrealizedMoney are unavailable without a finite mark price", () => {
    expect(marketValueMoney(pos(), 230)).toEqual({ kind: "ok", value: 2300, ccy: pos().ccy });
    expect(unrealizedMoney(pos(), 230).kind).toBe("ok");
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(marketValueMoney(pos(), bad).kind).toBe("unavailable");
      expect(unrealizedMoney(pos(), bad).kind).toBe("unavailable");
    }
  });
  it("flexRateFor skips rows with an unparseable date", () => {
    const rates = [{ fromCcy: "USD", toCcy: "EUR", rate: 0.9, rateDate: "garbage" }];
    expect(flexRateFor(rates, "USD", "EUR", "2026-10-14")).toBeNull();
  });
});
