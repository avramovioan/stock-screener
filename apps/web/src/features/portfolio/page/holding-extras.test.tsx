import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HoldingLink } from "./holdings-api";
import { PositionsTable } from "./positions-table";
import { makeRow, makeView } from "./test-fixtures";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    className,
  }: {
    children: ReactNode;
    params: { reportId: string };
    className?: string;
  }) => (
    <a href={`/research/${params.reportId}`} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/features/handoff/trade-on-ibkr-button", () => ({
  TradeOnIbkrButton: ({
    target,
  }: {
    target: {
      symbol: string;
      kind?: string;
      listingExchange?: string | null;
      isin?: string | null;
      position?: unknown;
    };
  }) => (
    <button
      type="button"
      data-testid="trade-on-ibkr-button"
      data-kind={target.kind ?? "screened"}
      data-exchange={target.listingExchange ?? ""}
      data-isin={target.isin ?? ""}
      data-position={JSON.stringify(target.position ?? null)}
    >{`Trade on IBKR ${target.symbol}`}</button>
  ),
}));

const view = makeView();
const monitored: HoldingLink = {
  conid: 100001,
  securityId: "sec-aapl",
  symbol: "AAPL",
  monitor: { reportId: "r-1", fullReportDate: "2026-10-01", lastCheckDate: "2026-10-14" },
};
const plain: HoldingLink = { conid: 100002, securityId: "sec-shel", symbol: "SHEL", monitor: null };
const etf: HoldingLink = {
  isin: "IE00BFMXXD54",
  conid: 100003,
  securityId: null,
  symbol: null,
  monitor: null,
  held: {
    symbol: "VUAA",
    listingExchange: "LSEETF",
    conid: 100003,
    description: "VANG S&P500 USDD",
    currency: "USD",
  },
};

function mount(links?: Map<number, HoldingLink>, rows = view.positions) {
  render(
    <PositionsTable
      rows={rows}
      totals={view.totals}
      perCurrency={view.perCurrency}
      base="EUR"
      links={links}
    />,
  );
  return screen.getByTestId("positions-table");
}

describe("holding extras", () => {
  it("a monitored holding shows the report and change-check dates apart, and links to the full report", () => {
    const table = mount(
      new Map([
        [100001, monitored],
        [100002, plain],
      ]),
    );
    fireEvent.click(within(table).getByRole("button", { name: "About AAPL" }));
    const block = screen.getByTestId("holding-research-AAPL");
    expect(
      within(block).getByText("Full report: 2026-10-01 · Last change check: 2026-10-14"),
    ).toBeTruthy();
    expect(
      within(block).getByRole("link", { name: "Open full report for AAPL" }).getAttribute("href"),
    ).toBe("/research/r-1");
  });

  it("a holding that is not monitored shows no research block", () => {
    const table = mount(
      new Map([
        [100001, monitored],
        [100002, plain],
      ]),
    );
    fireEvent.click(within(table).getByRole("button", { name: "About SHEL" }));
    expect(screen.queryByTestId("holding-research-SHEL")).toBeNull();
  });

  it("without link data (loading or failed) the table shows no extras at all", () => {
    const table = mount();
    expect(within(table).queryByTestId("holding-research-AAPL")).toBeNull();
    expect(within(table).queryByTestId("trade-on-ibkr-button")).toBeNull();
    expect(within(table).queryByText("Not screened")).toBeNull();
  });

  it("the card shows the same research block", () => {
    mount(new Map([[100001, monitored]]));
    const card = within(screen.getByTestId("positions-cards")).getByTestId("card-AAPL");
    expect(within(card).queryByRole("button", { name: "About AAPL" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /Details/ }));
    expect(within(card).getByTestId("holding-research-AAPL")).toBeTruthy();
  });
});

describe("Trade column", () => {
  const rows = [
    makeRow(),
    makeRow({ id: 3, conid: 100003, ticker: "VUAA", name: "VANG S&P500 USDD" }),
  ];
  const links = new Map<number, HoldingLink>([
    [100001, monitored],
    [100003, etf],
  ]);

  it("is the last column header", () => {
    const table = mount(links, rows);
    const heads = within(table).getAllByRole("columnheader");
    expect(heads.at(-1)?.textContent).toBe("Trade");
  });

  it("every row has the Trade button as its last cell; a screened holding keeps the canonical listing", () => {
    const table = mount(links, rows);
    const aapl = within(table).getByTestId("row-AAPL");
    const last = aapl.querySelectorAll("td");
    const cell = last[last.length - 1] as HTMLElement;
    const button = within(cell).getByTestId("trade-on-ibkr-button");
    expect(button.getAttribute("data-kind")).toBe("screened");
    expect(button.textContent).toBe("Trade on IBKR AAPL");
  });

  it("an unscreened ETF row gets the held-instrument target with its listing exchange", () => {
    const table = mount(links, rows);
    const vuaa = within(table).getByTestId("row-VUAA");
    const button = within(vuaa).getByTestId("trade-on-ibkr-button");
    expect(button.getAttribute("data-kind")).toBe("held");
    expect(button.getAttribute("data-exchange")).toBe("LSEETF");
    expect(button.getAttribute("data-isin")).toBe("IE00BFMXXD54");
    expect(button.textContent).toBe("Trade on IBKR VUAA");
  });

  it("a row the link query did not return still gets a held target (SMART routing) once links are loaded", () => {
    const table = mount(new Map([[100001, monitored]]), rows);
    const vuaa = within(table).getByTestId("row-VUAA");
    expect(within(vuaa).getByTestId("trade-on-ibkr-button").getAttribute("data-kind")).toBe("held");
  });

  it("the phone card carries the button too", () => {
    mount(links, rows);
    const card = within(screen.getByTestId("positions-cards")).getByTestId("card-VUAA");
    expect(within(card).getByTestId("trade-on-ibkr-button")).toBeTruthy();
  });

  it("the tag of an unscreened holding reads Not screened (grey); a screened one keeps its own tag", () => {
    const table = mount(links, rows);
    const vuaa = within(table).getByTestId("row-VUAA");
    const tag = within(vuaa).getByText("Not screened");
    expect(tag.closest("[data-tone]")?.getAttribute("data-tone")).toBe("grey");
    expect(within(within(table).getByTestId("row-AAPL")).queryByText("Not screened")).toBeNull();
  });
});

describe("trade position", () => {
  it("hands the row's figures, the held line and the statement date to the trade target", () => {
    render(
      <PositionsTable
        rows={view.positions}
        totals={view.totals}
        perCurrency={view.perCurrency}
        base="EUR"
        links={new Map([[100001, { ...etf, conid: 100001 }]])}
        reportDate="2026-10-17"
      />,
    );
    const row = view.positions[0];
    const button = within(screen.getByTestId("card-AAPL")).getByTestId("trade-on-ibkr-button");
    const position = JSON.parse(button?.getAttribute("data-position") ?? "null");
    expect(position).toMatchObject({
      quantity: row?.quantity,
      averageCost: row?.averageCost,
      currency: row?.currency,
      marketValue: row?.marketValue,
      unrealized: row?.unrealizedIndependent,
      reportDate: "2026-10-17",
    });
    expect(typeof position.heldSymbol).toBe("string");
  });

  it("the held line comes from the link, and the date is null without a statement date", () => {
    mount(new Map([[100001, { ...etf, conid: 100001 }]]));
    const pos = JSON.parse(
      within(screen.getByTestId("card-AAPL"))
        .getByTestId("trade-on-ibkr-button")
        .getAttribute("data-position") ?? "null",
    );
    expect(pos.heldSymbol).toBe("VUAA");
    expect(pos.heldExchange).toBe("LSEETF");
    expect(pos.reportDate).toBeNull();
  });
});
