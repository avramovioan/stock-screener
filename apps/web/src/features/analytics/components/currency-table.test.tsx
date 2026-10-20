import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeView } from "../../portfolio/page/test-fixtures";
import { buildAnalytics } from "../analytics-model";
import { makeData } from "../test-fixtures";
import { CurrencyTable } from "./currency-table";

describe("CurrencyTable", () => {
  it("one row per currency in its own unit, with a caption that says nothing is converted", () => {
    const m = buildAnalytics({
      base: "EUR",
      includeDividends: false,
      view: makeView(),
      data: makeData(),
    });
    render(<CurrencyTable rows={m.perCurrency} />);
    const table = screen.getByRole("table", { name: /Per-currency breakdown/ });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("+4.60 GBP")).toBeTruthy();
    expect(within(table).getByText("2,431.00 GBP")).toBeTruthy();
    expect(within(table).getByText("+2.21 USD")).toBeTruthy();
    expect(screen.getByText(/not converted/i)).toBeTruthy();
  });

  it("an unavailable cell is a dash with the reason, never 0", () => {
    const first = buildAnalytics({
      base: "EUR",
      includeDividends: false,
      view: makeView(),
      data: makeData(),
    }).perCurrency[0];
    if (first === undefined) throw new Error("no row");
    const rows = [
      {
        ...first,
        commissions: { kind: "unavailable" as const, reason: "Missing FX rate CHF->EUR" },
      },
    ];
    render(<CurrencyTable rows={rows} />);
    expect(screen.getByText("Unavailable: Missing FX rate CHF->EUR")).toBeTruthy();
  });

  it("an empty list renders an explanation", () => {
    render(<CurrencyTable rows={[]} />);
    expect(screen.getByText("No currency has any activity yet.")).toBeTruthy();
  });
});
