import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HoldingLink } from "./holdings-api";
import { PositionsTable } from "./positions-table";
import { makeRow, makeView, SHEL } from "./test-fixtures";

const revalue = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("./revalue-default", () => ({ revalueApi: { revalue } }));
vi.mock("sonner", () => ({ toast: { error: toastError, info: toastInfo, success: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/research/r-1">{children}</a>,
}));
vi.mock("@/features/handoff/trade-on-ibkr-button", () => ({
  TradeOnIbkrButton: () => <button type="button">Trade on IBKR</button>,
}));

const view = makeView();
const aapl: HoldingLink = {
  conid: 100001,
  securityId: "sec-aapl",
  symbol: "AAPL",
  monitor: { reportId: "r-1", fullReportDate: "2026-10-01", lastCheckDate: "2026-10-14" },
  held: {
    symbol: "AAPL",
    listingExchange: "NASDAQ",
    conid: 100001,
    description: "APPLE INC",
    currency: "USD",
  },
  isin: "US0378331005",
  screened: { exchangeCode: "NMS", exchangeName: "NASDAQ", rank: 4 },
};
const etf: HoldingLink = {
  conid: 100002,
  securityId: null,
  symbol: null,
  monitor: null,
  held: {
    symbol: "VUAA",
    listingExchange: "LSEETF",
    conid: 100002,
    description: "VANG S&amp;P500 USDD",
    currency: "USD",
  },
  isin: "IE00BFMXXD54",
};
const links = new Map([
  [100001, aapl],
  [100002, etf],
]);

function mount(onRevalued = vi.fn()) {
  const rows = [makeRow(), SHEL({ conid: 100002, ticker: "VUAA", name: "VANG S&amp;P500 USDD" })];
  render(
    <PositionsTable
      rows={rows}
      totals={view.totals}
      perCurrency={view.perCurrency}
      base="EUR"
      links={links}
      onRevalued={onRevalued}
    />,
  );
  return { table: screen.getByTestId("positions-table"), onRevalued };
}

const REEVALUATE = "Re-evaluate AAPL against today's channel";

beforeEach(() => {
  revalue.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
});

describe("holdings table layout", () => {
  it("columns are Ticker, Price, Qty, Value, P&L, Valuation, Trade in that order", () => {
    const { table } = mount();
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.trim());
    expect(heads).toEqual(["Ticker", "Price", "Qty", "Value", "P&L", "Valuation", "Trade"]);
    expect(table.className).toContain("table-fixed");
  });

  it("no Broker-reported text in the rows, no name column", () => {
    const { table } = mount();
    expect(within(table).queryByText(/Broker-reported/)).toBeNull();
    expect(within(table).queryByText("APPLE INC")).toBeNull();
    expect(within(table).queryAllByTestId("provenance-broker")).toHaveLength(0);
  });

  it("numbers never wrap", () => {
    const { table } = mount();
    const row = within(table).getByTestId("row-AAPL");
    expect(within(row).getByText("2,320.00 USD").className).toContain("whitespace-nowrap");
    for (const td of within(row).getAllByRole("cell").slice(1, 5))
      expect(td.className).toContain("whitespace-nowrap");
  });

  it("P&L shows unrealized with today's change beneath", () => {
    const { table } = mount();
    expect(within(within(table).getByTestId("row-AAPL")).getByText("+318.30 USD")).toBeTruthy();
    expect(within(table).getByText("+22.97 USD today")).toBeTruthy();
  });

  it("the ticker box of a screened holding carries name, held line, screened line, cost basis and research", () => {
    const { table } = mount();
    fireEvent.click(within(table).getByRole("button", { name: "About AAPL" }));
    const box = screen.getByRole("dialog", { name: "About AAPL" });
    const text = box.textContent ?? "";
    expect(text).toContain("APPLE INC");
    expect(text).toContain("AAPL on NASDAQ, USD");
    expect(text).toContain("ISIN US0378331005");
    expect(text).toContain("Screened asAAPL on NASDAQ · rank 4");
    expect(text).toContain("2,001.70 USD, broker-reported");
    expect(text).toContain("Full report: 2026-10-01");
    expect(within(box).getByRole("link", { name: /Open full report/ })).toBeTruthy();
  });

  it("the ticker box of an unscreened holding says so and shows the decoded name", () => {
    const { table } = mount();
    fireEvent.click(within(table).getByRole("button", { name: "About VUAA" }));
    const text = screen.getByRole("dialog", { name: "About VUAA" }).textContent ?? "";
    expect(text).toContain("VANG S&P500 USDD");
    expect(text).toContain("VUAA on LSEETF, USD");
    expect(text).toContain("Not a screened company");
    expect(text).not.toContain("Research");
  });

  it("two icon buttons sit under Trade; re-evaluate is disabled for an unscreened holding", () => {
    const { table } = mount();
    const a = within(table).getByTestId("row-AAPL");
    expect(within(a).getByRole("button", { name: REEVALUATE })).toHaveProperty("disabled", false);
    expect(
      within(a).getByRole("button", { name: "Copy the evaluation prompt for AAPL" }),
    ).toBeTruthy();
    const v = within(table).getByTestId("row-VUAA");
    expect(
      within(v).getByRole("button", { name: "Re-evaluate is only for screened companies" }),
    ).toHaveProperty("disabled", true);
    expect(
      within(v).getByRole("button", { name: "Copy the evaluation prompt for VUAA" }),
    ).toBeTruthy();
  });

  it("re-evaluate posts the conid and refetches the holdings", async () => {
    revalue.mockResolvedValue({ kind: "ok" });
    const { table, onRevalued } = mount();
    fireEvent.click(within(table).getByRole("button", { name: REEVALUATE }));
    await waitFor(() => expect(onRevalued).toHaveBeenCalledTimes(1));
    expect(revalue).toHaveBeenCalledWith(100001);
  });

  it("a 429 shows when the next re-evaluation is allowed, with a visible info toast", async () => {
    revalue.mockResolvedValue({ kind: "cooldown", nextAllowedAt: "2026-10-20T07:00:00Z" });
    const { table, onRevalued } = mount();
    fireEvent.click(within(table).getByRole("button", { name: REEVALUATE }));
    const note = await screen.findByText(/Re-evaluated already today; next at /);
    expect(note.textContent).toContain("10:00");
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(note.textContent);
    expect(onRevalued).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("any other failure toasts once", async () => {
    revalue.mockResolvedValue({ kind: "error", message: "The re-evaluation failed." });
    const { table } = mount();
    fireEvent.click(within(table).getByRole("button", { name: REEVALUATE }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  });

  it("copy the prompt writes the holding's prompt to the clipboard and says Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { table } = mount();
    fireEvent.click(
      within(table).getByRole("button", { name: "Copy the evaluation prompt for AAPL" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("- Name: APPLE INC");
    expect((await screen.findAllByText("Copied")).length).toBeGreaterThan(0);
  });
});
