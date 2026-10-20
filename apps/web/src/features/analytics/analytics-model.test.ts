import type { Money } from "@core/accounting.ts";
import { describe, expect, it } from "vitest";
import { makeView, na } from "../portfolio/page/test-fixtures";
import { buildAnalytics, coverageText } from "./analytics-model";
import { historicalToMoney } from "./analytics-page";
import { makeData } from "./test-fixtures";

const v = (m: Money): number => {
  if (m.kind !== "ok") throw new Error(`unavailable: ${m.reason}`);
  return m.value;
};
const view = makeView(); // unrealized (calculated, EUR) = 296.02 - 80.04 = 215.98, value 4977.56
const build = (o: Partial<Parameters<typeof buildAnalytics>[0]> = {}) =>
  buildAnalytics({ base: "EUR", includeDividends: false, view, data: makeData(), ...o });

describe("figures and their origin", () => {
  const m = build();

  it("total value: the broker NAV of the last statement date and, separately, the positions at delayed prices", () => {
    expect(v(m.totalValue.nav)).toBe(9950.2);
    expect(m.totalValue.navDate).toBe("2026-10-14");
    expect(v(m.totalValue.calculated)).toBeCloseTo(4977.56, 6);
  });

  it("cost basis is the Flex cost basis converted with the Flex rates (broker-reported)", () => {
    expect(v(m.costBasis)).toBeCloseTo(2001.7 * 0.92 + 2500 * 1.15, 8);
  });

  it("unrealized P&L: independently calculated (current prices) and broker FIFO (statement)", () => {
    expect(v(m.unrealized.calculated)).toBeCloseTo(215.98, 6);
    expect(v(m.unrealized.broker)).toBeCloseTo(298.3 * 0.92 + 235 * 1.15, 8);
  });

  it("realized trading P&L is the sum of the closed lots of the partial sale in the base currency, commissions not subtracted again", () => {
    expect(m.realized.lotCount).toBe(2);
    expect(m.realized.byCcy["GBP"]).toBeCloseTo(4.6, 10);
    expect(v(m.realized.base)).toBeCloseTo(4.6 * 1.15, 10);
  });

  it("dividends gross, withholding and net are separate", () => {
    expect(v(m.dividends.gross)).toBeCloseTo(2.6 * 0.92, 10);
    expect(v(m.dividends.withholding)).toBeCloseTo(-0.39 * 0.92, 10);
    expect(v(m.dividends.net)).toBeCloseTo(2.21 * 0.92, 10);
  });

  it("commissions are a memo (already inside realized P&L); fees and interest are the other costs", () => {
    expect(v(m.costs.commissions)).toBeCloseTo(1.7 * 0.92 + 0.4 * 1.15, 10);
    expect(v(m.costs.other)).toBeCloseTo(2, 10);
  });

  it("a commission in another currency than the trade uses the Flex conversion rate of the trade date", () => {
    const data = makeData({
      trades: [
        {
          commission: -1,
          commissionCcy: "USD",
          tradeCcy: "GBP",
          fxToBase: 1.15,
          tradeDate: "2026-10-14",
        },
      ],
    });
    expect(v(build({ data }).costs.commissions)).toBeCloseTo(0.92, 10);
    const noRate = makeData({
      trades: [
        {
          commission: -1,
          commissionCcy: "CHF",
          tradeCcy: "GBP",
          fxToBase: 1.15,
          tradeDate: "2026-10-14",
        },
      ],
    });
    expect(build({ data: noRate }).costs.commissions.kind).toBe("unavailable");
  });
});

describe("the include-dividends toggle feeds the combined performance", () => {
  const realized = 4.6 * 1.15;
  const unrealized = 215.98;
  const dividendsNet = 2.21 * 0.92;
  const other = 2;

  it("excluded: realized plus unrealized; with other costs as a separate line", () => {
    const m = build({ includeDividends: false });
    expect(v(m.combined)).toBeCloseTo(realized + unrealized, 8);
    expect(v(m.combinedAfterOtherCosts)).toBeCloseTo(realized + unrealized - other, 8);
  });

  it("included: adds the NET dividends exactly once", () => {
    const m = build({ includeDividends: true });
    expect(v(m.combined)).toBeCloseTo(realized + unrealized + dividendsNet, 8);
    expect(v(m.combinedAfterOtherCosts)).toBeCloseTo(
      realized + unrealized + dividendsNet - other,
      8,
    );
  });

  it("toggling never double counts: included minus excluded equals net dividends", () => {
    expect(
      v(build({ includeDividends: true }).combined) -
        v(build({ includeDividends: false }).combined),
    ).toBeCloseTo(dividendsNet, 10);
  });

  it("an unavailable calculated unrealized figure makes the combined figure unavailable, not zero", () => {
    const m = build({
      view: makeView(undefined, {
        totals: { ...view.totals, unrealizedBase: na("Missing FX rate USD->EUR") },
      }),
    });
    expect(m.combined.kind).toBe("unavailable");
    expect(m.combinedAfterOtherCosts.kind).toBe("unavailable");
  });

  it("without valued positions the calculated figures are unavailable with a reason", () => {
    const m = build({ view: null });
    expect(m.totalValue.calculated.kind).toBe("unavailable");
    expect(m.combined.kind).toBe("unavailable");
  });
});

describe("history, coverage and breakdown", () => {
  it("historical performance is NAV minus net flows after the first NAV date; unavailable when transfers are not valued", () => {
    const m = build();
    expect(m.historical.kind).toBe("ok");
    if (m.historical.kind === "ok")
      expect(m.historical.points.at(-1)?.performance).toBeCloseTo(149.65, 8);
    const withTransfers = build({ data: makeData({ hasUnvaluedTransfers: true }) });
    expect(withTransfers.historical.kind).toBe("unavailable");
    expect(build({ data: makeData({ nav: [] }) }).historical.kind).toBe("unavailable");
  });

  it("NAV points feed the chart; fewer than two rows is reported", () => {
    expect(build().navPoints).toEqual([
      { date: "2026-10-13", value: 9800.55 },
      { date: "2026-10-14", value: 9950.2 },
    ]);
    expect(
      build({ data: makeData({ nav: [{ date: "2026-10-14", total: 9950.2, ccy: "EUR" }] }) })
        .navPoints,
    ).toHaveLength(1);
  });

  it("coverage text names the loaded period and warns about earlier activity", () => {
    expect(coverageText("2025-10-15", "2026-10-14")).toBe(
      "History loaded from 15 Oct 2025 to 14 Oct 2026 — earlier activity is not included. Realized P&L may be incomplete before 15 Oct 2025.",
    );
    expect(coverageText(null, null)).toBe("No statement history is loaded yet.");
    expect(coverageText("2025-10-15", null)).toContain("History loaded from 15 Oct 2025");
  });

  it("per-currency breakdown shows each currency in its own unit", () => {
    const rows = build().perCurrency;
    expect(rows.map((r) => r.ccy)).toEqual(["EUR", "GBP", "USD"]);
    const gbp = rows.find((r) => r.ccy === "GBP");
    expect(v(gbp?.realized as Money)).toBeCloseTo(4.6, 10);
    expect(v(gbp?.commissions as Money)).toBeCloseTo(0.4, 10);
    expect(v(gbp?.value as Money)).toBe(2431);
    const usd = rows.find((r) => r.ccy === "USD");
    expect(v(usd?.dividendsNet as Money)).toBeCloseTo(2.21, 10);
    expect(v(usd?.commissions as Money)).toBeCloseTo(1.7, 10);
    const eur = rows.find((r) => r.ccy === "EUR");
    expect(v(eur?.otherCosts as Money)).toBeCloseTo(2, 10);
  });

  it("no positions and no history give honest zeros only where the data is genuinely empty", () => {
    const m = build({
      view: makeView([]),
      data: makeData({ lots: [], cash: [], trades: [], positions: [], nav: [] }),
    });
    expect(v(m.realized.base)).toBe(0);
    expect(v(m.dividends.net)).toBe(0);
    expect(v(m.costBasis)).toBe(0);
    expect(m.totalValue.nav.kind).toBe("unavailable");
  });
});

describe("never zero when the portfolio view is missing", () => {
  it("per-currency cost, value and unrealized are unavailable without a view", () => {
    const m = build({ view: null });
    expect(m.perCurrency.length).toBeGreaterThan(0);
    for (const r of m.perCurrency)
      for (const x of [r.cost, r.value, r.unrealized]) expect(x.kind).toBe("unavailable");
  });
});

describe("historicalToMoney", () => {
  it("empty points are unavailable (No NAV history), never 0", () => {
    const m = historicalToMoney({ kind: "ok", points: [] } as never, "EUR");
    expect(m).toEqual({ kind: "unavailable", reason: "No NAV history" });
  });
  it("uses the last point", () => {
    expect(historicalToMoney({ kind: "ok", points: [{ performance: 5 }] } as never, "EUR")).toEqual(
      { kind: "ok", value: 5, ccy: "EUR" },
    );
  });
});
