import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PositionsTable } from "./positions-table";
import { makeRow, makeView, NOPX, ok, SHEL } from "./test-fixtures";

const view = makeView();

function mount(rows = view.positions) {
  render(
    <PositionsTable rows={rows} totals={view.totals} perCurrency={view.perCurrency} base="EUR" />,
  );
  return {
    table: screen.getByTestId("positions-table"),
    cards: screen.getByTestId("positions-cards"),
  };
}
const order = (container: HTMLElement) =>
  within(container)
    .getAllByTestId("row-ticker")
    .map((el) => el.textContent);

describe("PositionsTable", () => {
  it("default order is unrealized P&L ascending (most negative first) with unavailable last, and the header says so", () => {
    const { table } = mount();
    expect(order(table)).toEqual(["SHEL", "AAPL", "NOPX"]);
    const header = within(table).getByRole("columnheader", { name: /P&L/ });
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(
      within(table)
        .getByRole("columnheader", { name: /Ticker/ })
        .getAttribute("aria-sort"),
    ).toBe("none");
  });

  it("every column header sorts; a second click reverses; unavailable rows stay last", () => {
    const { table } = mount();
    const click = (name: RegExp) => fireEvent.click(within(table).getByRole("button", { name }));
    click(/^P&L$/);
    expect(order(table)).toEqual(["AAPL", "SHEL", "NOPX"]);
    click(/Value/);
    expect(order(table)).toEqual(["AAPL", "SHEL", "NOPX"]);
    click(/Value/);
    expect(order(table)).toEqual(["SHEL", "AAPL", "NOPX"]);
    for (const label of [/Ticker/, /^Price$/, /Qty/, /Valuation/]) {
      click(label);
      expect(
        within(table).getByRole("columnheader", { name: label }).getAttribute("aria-sort"),
      ).toBe("ascending");
    }
  });

  it("price cell: delayed quote with its time and market state, or the statement close labelled; currency code as text", () => {
    const { table } = mount();
    const aapl = within(table).getByTestId("row-AAPL");
    expect(within(aapl).getByText("232.00 USD")).toBeTruthy();
    fireEvent.click(within(aapl).getByRole("button", { name: "Price details for AAPL" }));
    expect(screen.getByRole("dialog").textContent).toMatch(
      /Delayed quote, 15 Oct 2026, 09:59, REGULAR/,
    );
    const shel = within(table).getByTestId("row-SHEL");
    expect(within(shel).getByText("24.31 GBP")).toBeTruthy();
    fireEvent.click(within(shel).getByRole("button", { name: "Price details for SHEL" }));
    expect(screen.getByRole("dialog").textContent).toContain("14 Oct 2026");
  });

  it("unavailable figures are a dash with the reason, never 0", () => {
    const { table } = mount();
    const row = within(table).getByTestId("row-NOPX");
    expect(within(row).getAllByText(/^Unavailable: /).length).toBeGreaterThanOrEqual(4);
    expect(within(row).queryByText(/^0\.00/)).toBeNull();
  });

  it("unrealized P&L is the independent value; the broker FIFO value is in the info box; a mismatch gets a visible marker", () => {
    const rows = [makeRow({ reconciles: false }), SHEL()];
    const { table } = mount(rows);
    const aapl = within(table).getByTestId("row-AAPL");
    expect(within(aapl).getByText("+318.30 USD")).toBeTruthy();
    fireEvent.click(within(aapl).getByRole("button", { name: "Price details for AAPL" }));
    expect(screen.getByRole("dialog").textContent).toContain(
      "Broker-reported FIFO at the statement close: +298.30 USD",
    );
    expect(within(aapl).getByText("Does not reconcile")).toBeTruthy();
    expect(
      within(within(table).getByTestId("row-SHEL")).queryByText("Does not reconcile"),
    ).toBeNull();
  });

  it("valuation tags are text: Discounted, Premium, Extra premium, Unavailable, and none is an em dash with hidden text", () => {
    const rows = [
      makeRow({ id: 1, ticker: "D", tag: "discounted" }),
      makeRow({ id: 2, ticker: "P", tag: "premium" }),
      SHEL(),
      NOPX(),
      makeRow({ id: 5, ticker: "N", tag: "none" }),
    ];
    const { table } = mount(rows);
    for (const label of ["Discounted", "Premium", "Extra premium", "Unavailable"])
      expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(within(table).getByTestId("row-N")).getByText("within channel")).toBeTruthy();
    fireEvent.click(
      within(within(table).getByTestId("row-D")).getByRole("button", {
        name: "Price details for D",
      }),
    );
    expect(screen.getByRole("dialog").textContent).toContain("based on close of 2026-10-14");
  });

  it("the summary row is the last row of the table and shows the base totals", () => {
    const { table } = mount();
    const rows = within(table).getAllByRole("row");
    expect(rows.at(-1)?.textContent).toContain("Total in EUR");
    expect(rows.at(-1)?.textContent).toContain("4,977.56 EUR");
  });

  it("each position also appears as a card, with a Sort control", () => {
    const { cards } = mount();
    const card = within(cards).getByTestId("card-SHEL");
    for (const label of ["Value", "P&L"]) {
      expect(within(card).getByText(label)).toBeTruthy();
    }
    fireEvent.change(within(cards).getByLabelText("Sort"), { target: { value: "ticker" } });
    expect(
      within(cards)
        .getAllByTestId("card-ticker")
        .map((e) => e.textContent),
    ).toEqual(["AAPL", "NOPX", "SHEL"]);
    fireEvent.click(within(cards).getByRole("button", { name: /A to Z/ }));
    expect(
      within(cards)
        .getAllByTestId("card-ticker")
        .map((e) => e.textContent),
    ).toEqual(["SHEL", "NOPX", "AAPL"]);
  });

  it("converted values name their basis (Yahoo rate and date, or the statement rate)", () => {
    const { table } = mount([
      makeRow({ valueBase: ok(2157.6, "EUR") }),
      SHEL({ fxSource: "flex", fxDate: "2026-10-14" }),
    ]);
    fireEvent.click(
      within(within(table).getByTestId("row-AAPL")).getByRole("button", {
        name: "Price details for AAPL",
      }),
    );
    expect(screen.getByRole("dialog").textContent).toMatch(
      /2,157\.60 EUR.*Yahoo rate of 15 Oct 2026/,
    );
    fireEvent.click(
      within(within(table).getByTestId("row-SHEL")).getByRole("button", {
        name: "Price details for SHEL",
      }),
    );
    expect(screen.getByRole("dialog").textContent).toMatch(/statement rate of 14 Oct 2026/);
  });

  it("an empty list renders an explanation instead of an empty table", () => {
    render(<PositionsTable rows={[]} totals={view.totals} perCurrency={[]} base="EUR" />);
    expect(screen.getByText("No open positions in the latest statement.")).toBeTruthy();
  });
});
