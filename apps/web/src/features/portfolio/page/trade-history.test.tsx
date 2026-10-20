import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { validatePortfolioSearch } from "./search-params";
import { TradeHistory } from "./trade-history";
import { NO_FILTERS, type TradeRow } from "./trades-api";

const page = vi.fn();
const currencies = vi.fn();
vi.mock("./trades-default", () => ({
  tradesApi: {
    page: (...a: unknown[]) => page(...a),
    currencies: (...a: unknown[]) => currencies(...a),
  },
}));

const row = (o: Partial<TradeRow> = {}): TradeRow => ({
  id: 3,
  trade_id: "2002001",
  ib_exec_id: "e3",
  ib_order_id: "5002",
  symbol: "SHEL",
  description: "SHELL PLC",
  exchange: "LSE",
  listing_exchange: "LSE",
  currency: "GBP",
  trade_date: "2026-10-08",
  trade_time: "11:05:00",
  buy_sell: "SELL",
  quantity: -4,
  trade_price: 26.5,
  ib_commission: -0.4,
  ib_commission_currency: "GBP",
  net_cash: 105.6,
  fifo_pnl_realized: 4.6,
  open_close: "C",
  ...o,
});
const buys = [
  row({
    id: 2,
    trade_id: "1001002",
    ib_exec_id: "e2",
    ib_order_id: "5001",
    symbol: "AAPL",
    description: "APPLE INC",
    exchange: "NASDAQ",
    currency: "USD",
    trade_date: "2026-10-09",
    trade_time: "09:30:07",
    buy_sell: "BUY",
    quantity: 4,
    trade_price: 200.75,
    ib_commission: -0.7,
    ib_commission_currency: "USD",
    net_cash: -803.7,
    fifo_pnl_realized: 0,
    open_close: "O",
  }),
  row({
    id: 1,
    trade_id: "1001001",
    ib_exec_id: "e1",
    ib_order_id: "5001",
    symbol: "AAPL",
    description: "APPLE INC",
    exchange: "NASDAQ",
    currency: "USD",
    trade_date: "2026-10-09",
    trade_time: "09:30:01",
    buy_sell: "BUY",
    quantity: 6,
    trade_price: 199.5,
    ib_commission: -1,
    ib_commission_currency: "USD",
    net_cash: -1198,
    fifo_pnl_realized: 0,
    open_close: "O",
  }),
];

function mount(url = "/portfolio") {
  return renderWithProviders(<TradeHistory />, {
    path: "/portfolio",
    url,
    validateSearch: validatePortfolioSearch,
  });
}

beforeEach(() => {
  page.mockReset();
  currencies.mockReset();
  currencies.mockResolvedValue(["CHF", "EUR", "USD"]);
});

describe("TradeHistory", () => {
  it("shows executions in the order given (newest first) with every column", async () => {
    page.mockResolvedValue({ rows: [row(), ...buys], total: 3 });
    mount();
    const table = await screen.findByTestId("trades-table");
    expect(
      within(table)
        .getAllByTestId("trade-symbol")
        .map((e) => e.textContent),
    ).toEqual(["SHEL", "AAPL", "AAPL"]);
    const sell = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(within(sell).getByText("8 Oct 2026")).toBeTruthy();
    expect(within(sell).getByText("Sell")).toBeTruthy();
    expect(within(sell).getByText("4")).toBeTruthy();
    expect(within(sell).getByText("26.50 GBP")).toBeTruthy();
    expect(within(sell).getByText("LSE")).toBeTruthy();
    expect(within(sell).getByText("0.40 GBP")).toBeTruthy();
    expect(within(sell).getByText("+105.60 GBP")).toBeTruthy();
    expect(within(sell).getByText("+4.60 GBP")).toBeTruthy();
  });

  it("a partial fill is shown as separate executions of one order", async () => {
    page.mockResolvedValue({ rows: buys, total: 2 });
    mount();
    const table = await screen.findByTestId("trades-table");
    expect(within(table).getAllByText("Order 5001 (2 fills)")).toHaveLength(2);
    expect(within(table).getByText("6")).toBeTruthy();
    expect(within(table).getByText("4")).toBeTruthy();
    expect(within(table).getByText("199.50 USD")).toBeTruthy();
    expect(within(table).getByText("200.75 USD")).toBeTruthy();
  });

  it("opening trades show a dash for realized P&L, never 0", async () => {
    page.mockResolvedValue({ rows: [buys[1] as TradeRow], total: 1 });
    mount();
    const table = await screen.findByTestId("trades-table");
    expect(within(table).queryByText(/0\.00 USD/)).toBeNull();
    expect(within(table).getByText("Unavailable: opening trade, nothing realized")).toBeTruthy();
  });

  it("pagination: counts, Next and Previous, page size 25", async () => {
    page.mockImplementation((i: number) =>
      Promise.resolve({
        rows:
          i === 0
            ? Array.from({ length: 25 }, (_, k) => row({ id: 100 - k, ib_exec_id: `x${k}` }))
            : [row({ id: 1, ib_exec_id: "last" })],
        total: 26,
      }),
    );
    mount();
    expect(await screen.findByText("Showing 1-25 of 26")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26-26 of 26")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(page).toHaveBeenCalledWith(1, NO_FILTERS);
  });

  it("empty and error states", async () => {
    page.mockResolvedValueOnce({ rows: [], total: 0 });
    mount();
    expect(await screen.findByText("No executions in the loaded statements.")).toBeTruthy();
  });

  it("an error offers Retry", async () => {
    page
      .mockRejectedValueOnce(new Error("Could not load the trade history."))
      .mockResolvedValue({ rows: [row()], total: 1 });
    mount();
    expect(await screen.findByText("Could not load the trade history.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("trades-table")).toBeTruthy();
  });

  it("every execution is also a card with all fields", async () => {
    page.mockResolvedValue({ rows: [row()], total: 1 });
    mount();
    const card = await screen.findByTestId("trade-card-e3");
    for (const label of [
      "Date",
      "Instrument",
      "Action",
      "Quantity",
      "Execution price",
      "Exchange",
      "Commission",
      "Net cash",
      "Realized P&L",
      "Order",
    ]) {
      expect(within(card).getByText(label)).toBeTruthy();
    }
  });

  it("labels the money columns as broker-reported in the table and in the cards", async () => {
    page.mockResolvedValue({ rows: [row()], total: 1 });
    mount();
    const table = await screen.findByTestId("trades-table");
    const sell = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(within(sell).getAllByText("Broker-reported")).toHaveLength(3);
    const card = screen.getByTestId("trade-card-e3");
    expect(within(card).getAllByText("Broker-reported")).toHaveLength(3);
  });
});

describe("TradeHistory filters", () => {
  it("shows the filter bar and the results line", async () => {
    page.mockResolvedValue({ rows: [row(), ...buys], total: 3 });
    mount();
    await screen.findByTestId("trades-table");
    for (const label of ["Symbol or name", "Type", "Side", "Currency", "From", "To"])
      expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    expect(screen.getByText("3 executions match")).toBeTruthy();
    expect(page).toHaveBeenCalledWith(0, NO_FILTERS);
  });

  it("offers All, the three types and the three sides, and All plus the currencies seen", async () => {
    page.mockResolvedValue({ rows: [row()], total: 1 });
    mount();
    await screen.findByTestId("trades-table");
    const opts = (label: string) =>
      within(screen.getByLabelText(label))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(opts("Type")).toEqual(["All", "Stocks and ETFs", "Currency (FX)", "Bonds"]);
    expect(opts("Side")).toEqual(["All", "Buy", "Sell"]);
    await waitFor(() => expect(opts("Currency")).toEqual(["All", "CHF", "EUR", "USD"]));
  });

  it("starts from the address: the controls show it and the query uses it", async () => {
    page.mockResolvedValue({ rows: [row()], total: 1 });
    mount("/portfolio?q=SHEL&side=SELL&ccy=GBP&type=stocks&from=2026-01-01&to=2026-10-19");
    await screen.findByTestId("trades-table");
    expect((screen.getByLabelText("Symbol or name") as HTMLInputElement).value).toBe("SHEL");
    expect((screen.getByLabelText("Side") as HTMLSelectElement).value).toBe("SELL");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("stocks");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-01-01");
    expect(page).toHaveBeenCalledWith(0, {
      q: "SHEL",
      type: "stocks",
      side: "SELL",
      ccy: "GBP",
      from: "2026-01-01",
      to: "2026-10-19",
    });
    expect(screen.getByText("1 execution matches")).toBeTruthy();
  });

  it("a change refetches with the filter and is mirrored in the address; paging restarts at the first page", async () => {
    page.mockResolvedValue({ rows: [row()], total: 60 });
    const { router } = mount();
    await screen.findByTestId("trades-table");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");
    fireEvent.change(screen.getByLabelText("Side"), { target: { value: "BUY" } });
    await screen.findByText("Page 1 of 3");
    expect(page).toHaveBeenLastCalledWith(0, { ...NO_FILTERS, side: "BUY" });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ side: "BUY" }));
  });

  it("Clear filters resets the controls, the query and the address", async () => {
    page.mockResolvedValue({ rows: [row()], total: 1 });
    const { router } = mount("/portfolio?q=SHEL&ccy=GBP");
    await screen.findByTestId("trades-table");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(page).toHaveBeenLastCalledWith(0, NO_FILTERS));
    expect((screen.getByLabelText("Symbol or name") as HTMLInputElement).value).toBe("");
    expect(router.state.location.search).toEqual({});
  });

  it("no match keeps the bar and says so; the unfiltered empty state is unchanged", async () => {
    page.mockResolvedValue({ rows: [], total: 0 });
    mount("/portfolio?q=ZZZ");
    expect(await screen.findByText("No executions match these filters.")).toBeTruthy();
    expect(screen.getByText("0 executions match")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });

  it("a filtered view that errors still offers Clear filters", async () => {
    page.mockRejectedValue(new Error("Could not load the trade history."));
    mount("/portfolio?q=ZZZ");
    expect(await screen.findByText("Could not load the trade history.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });

  it("a pending text edit does not overwrite a control changed meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      page.mockResolvedValue({ rows: [row()], total: 1 });
      const { router } = mount();
      await screen.findByTestId("trades-table");
      fireEvent.change(screen.getByLabelText("Symbol or name"), { target: { value: "AAPL" } });
      fireEvent.change(screen.getByLabelText("Side"), { target: { value: "BUY" } });
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() =>
        expect(router.state.location.search).toMatchObject({ q: "AAPL", side: "BUY" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
