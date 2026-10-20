import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PositionsTable } from "./positions-table";
import { makeRow, makeView, NOPX, SHEL } from "./test-fixtures";

const view = makeView();

function mount(rows = view.positions) {
  render(
    <PositionsTable rows={rows} totals={view.totals} perCurrency={view.perCurrency} base="EUR" />,
  );
  return screen.getByTestId("positions-table");
}
const open = (scope: HTMLElement, name: string | RegExp) =>
  fireEvent.click(within(scope).getByRole("button", { name }));

describe("holdings info boxes", () => {
  it("the cells carry only numbers: no grey small print for source, basis or FIFO", () => {
    const table = mount([makeRow(), SHEL()]);
    expect(within(table).queryByText(/delayed quote, /i)).toBeNull();
    expect(within(table).queryByText(/close of 14 Oct 2026/)).toBeNull();
    expect(within(table).queryByText(/broker FIFO at close/)).toBeNull();
    expect(within(table).queryByText(/Yahoo rate, /)).toBeNull();
    expect(within(table).queryByText("based on close of 2026-10-14")).toBeNull();
    expect(within(table).queryByText("Calculated by this app")).toBeNull();
  });

  it("each of Price, Value, Unrealized P&L and Valuation has a header box with the general explanation", () => {
    const table = mount();
    open(table, "About the price");
    expect(screen.getByRole("dialog", { name: "About the price" }).textContent).toMatch(
      /delayed quote/i,
    );
    open(table, "About the value");
    expect(screen.getByRole("dialog", { name: "About the value" }).textContent).toMatch(
      /Quantity × price/,
    );
    open(table, "About unrealized and daily P&L");
    expect(
      screen.getByRole("dialog", { name: "About unrealized and daily P&L" }).textContent,
    ).toMatch(/calculated by this app/i);
    open(table, "About the valuation tag");
    const tag = screen.getByRole("dialog", { name: "About the valuation tag" });
    expect(tag.textContent).toContain("Not screened = not a company in the list");
  });

  it("only one box is open at a time", () => {
    const table = mount();
    open(table, "About the price");
    open(table, "About the value");
    expect(screen.queryByRole("dialog", { name: "About the price" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "About the value" })).toBeTruthy();
  });

  it("the Price cell box lists this row's quote source and time, FX basis, calculated figures, broker FIFO and reconciliation", () => {
    const table = mount([makeRow({ reconciles: true })]);
    open(within(table).getByTestId("row-AAPL"), "Price details for AAPL");
    const box = screen.getByRole("dialog", { name: "Price details for AAPL" });
    const text = box.textContent ?? "";
    expect(text).toContain("Price · AAPL");
    expect(text).toMatch(/Delayed quote, 15 Oct 2026, 09:59, REGULAR/);
    expect(text).toContain("Calculated by this app");
    expect(text).toContain("Yahoo rate of 15 Oct 2026");
    expect(text).toContain("Broker-reported FIFO at the statement close: +298.30 USD");
    expect(text).toContain("Reconciles with the broker figure");
    expect(text).toContain("based on close of 2026-10-14");
  });

  it("a statement-close price names the statement date; a mismatch is stated in the box and marked in the cell", () => {
    const table = mount([SHEL({ reconciles: false })]);
    expect(within(table).getByText("Does not reconcile")).toBeTruthy();
    open(within(table).getByTestId("row-SHEL"), "Price details for SHEL");
    const text = screen.getByRole("dialog", { name: "Price details for SHEL" }).textContent ?? "";
    expect(text).toContain("Statement close");
    expect(text).toContain("14 Oct 2026");
    expect(text).toContain("Does not reconcile");
  });

  it("an unpriced row still explains itself", () => {
    const table = mount([NOPX()]);
    open(within(table).getByTestId("row-NOPX"), "Price details for NOPX");
    expect(screen.getByRole("dialog", { name: "Price details for NOPX" }).textContent).toContain(
      "no delayed quote",
    );
  });

  it("the phone card has no row box; its price facts sit under Details", () => {
    mount([makeRow()]);
    const card = within(screen.getByTestId("positions-cards")).getByTestId("card-AAPL");
    expect(within(card).queryByRole("button", { name: "Price details for AAPL" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /Details/ }));
    expect(card.textContent).toContain("Delayed quote");
  });
});
