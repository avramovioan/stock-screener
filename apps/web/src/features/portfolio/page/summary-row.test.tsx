import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SummaryCard } from "./summary-row";
import { makeTotals, makeView, na, ok } from "./test-fixtures";

const view = makeView();

describe("SummaryCard", () => {
  it("shows total cost basis, market value, daily P&L and unrealized P&L in the base currency", () => {
    render(<SummaryCard totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
    const card = screen.getByRole("region", { name: "Portfolio summary" });
    expect(within(card).getByText("4,761.58 EUR")).toBeTruthy();
    expect(within(card).getByText("4,977.56 EUR")).toBeTruthy();
    expect(within(card).getByText("+21.36 EUR")).toBeTruthy();
    expect(within(card).getByText("+215.98 EUR")).toBeTruthy();
  });

  it("the explanation lives in an info box, not in the page: conversion basis and what was excluded from the totals", () => {
    render(<SummaryCard totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
    expect(screen.queryByText(/Converted to EUR at current rates/)).toBeNull();
    expect(screen.queryByText("Calculated at delayed prices")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How these are computed" }));
    expect(screen.getByText(/Converted to EUR at current rates/)).toBeTruthy();
    expect(
      screen.getByText(
        /1 position is excluded from the totals: NOPX \(Cost basis missing in the statement\)/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Daily P&L leaves out 1 position without a delayed quote/),
    ).toBeTruthy();
  });

  it("a per-currency breakdown popover shows each currency in its own unit, never a mixed sum", () => {
    render(<SummaryCard totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
    fireEvent.click(screen.getByRole("button", { name: "Per-currency breakdown" }));
    const panel = screen.getByRole("dialog", { name: "Per-currency breakdown" });
    expect(within(panel).getByText("GBP")).toBeTruthy();
    expect(within(panel).getByText("2,431.00 GBP")).toBeTruthy();
    expect(within(panel).getByText("USD")).toBeTruthy();
    expect(within(panel).getByText("2,320.00 USD")).toBeTruthy();
  });

  it("unavailable totals render a dash with the reason, never 0", () => {
    const totals = makeTotals({
      valueBase: na("Missing FX rate USD->EUR"),
      costBase: na("Missing FX rate USD->EUR"),
      unrealizedBase: na("Missing FX rate USD->EUR"),
      dailyBase: na("Daily change unavailable"),
      excluded: [],
      dailyExcluded: 0,
    });
    render(<SummaryCard totals={totals} perCurrency={view.perCurrency} base="EUR" />);
    expect(screen.getAllByText("Unavailable: Missing FX rate USD->EUR").length).toBe(3);
    expect(screen.queryByText("0.00 EUR")).toBeNull();
  });

  it("an empty portfolio is a real zero", () => {
    render(
      <SummaryCard
        totals={makeTotals({
          costBase: ok(0, "EUR"),
          valueBase: ok(0, "EUR"),
          unrealizedBase: ok(0, "EUR"),
          dailyBase: ok(0, "EUR"),
          included: 0,
          excluded: [],
          dailyExcluded: 0,
        })}
        perCurrency={[]}
        base="EUR"
      />,
    );
    expect(screen.getAllByText("0.00 EUR").length).toBe(4);
  });
});
