import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRADE_BUTTON_LABEL, TradeOnIbkrButton } from "./trade-on-ibkr-button";
import type { TradeTarget } from "./types";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
  quotes: { useQuotes: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);
vi.mock("@/features/screening/quotes-hooks", () => mocks.quotes);

const TARGET: TradeTarget = {
  securityId: "sec-msft",
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  rank: 53,
  exchangeName: "NasdaqGS",
  currency: "USD",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoffApi.getEurListings.mockResolvedValue([]);
  mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
  mocks.auth.useAuth.mockReturnValue({ status: "signed-in", user: { id: "u1" }, recovery: false });
  mocks.quotes.useQuotes.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
});
afterEach(() => cleanup());

describe("TradeOnIbkrButton", () => {
  const renderButton = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TradeOnIbkrButton target={TARGET} />
      </QueryClientProvider>,
    );

  it("is labelled Trade on IBKR (never Submit Order) and loads nothing until it is clicked", () => {
    renderButton();
    expect(TRADE_BUTTON_LABEL).toBe("Trade on IBKR");
    expect(screen.getByRole("button", { name: "Trade on IBKR" })).toBeTruthy();
    expect(mocks.handoffApi.getEurListings).not.toHaveBeenCalled();
    expect(mocks.handoffApi.getDefaultDestination).not.toHaveBeenCalled();
  });

  it("opens the hand-off dialog for the target on click and closes it again", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Trade on IBKR" }));
    expect(await screen.findByTestId("trade-dialog")).toBeTruthy();
    expect(screen.getByText("#53 MSFT — Microsoft Corporation")).toBeTruthy();
    expect(mocks.handoffApi.getEurListings).toHaveBeenCalledWith("sec-msft");
    fireEvent.keyDown(screen.getByTestId("trade-dialog"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByTestId("trade-dialog")).toBeNull());
  });
});
