import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeTarget } from "@/features/handoff/types";
import { TradeControl } from "./discount-card";

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
// TradeControl keeps P4's router <Link>; this unit renders without a RouterProvider, so Link is a plain anchor here.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
}));

const TARGET: TradeTarget = {
  securityId: "sec-msft",
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  rank: 53,
  exchangeName: "NasdaqGS",
  currency: "USD",
};

const renderControl = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TradeControl target={TARGET} />
    </QueryClientProvider>,
  );

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

describe("TradeControl (Trade on IBKR for every viewer)", () => {
  it("a signed-out visitor gets the enabled button, never a sign-in or Profile link", async () => {
    mocks.auth.useAuth.mockReturnValue({ status: "signed-out", user: null, recovery: false });
    renderControl();
    const button = screen.getByTestId("trade-on-ibkr-button") as HTMLButtonElement;
    expect(button.textContent).toBe("Trade on IBKR");
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/sign in to trade/i)).toBeNull();
    expect(screen.queryByText(/link ibkr in profile/i)).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByTestId("trade-dialog")).toBeTruthy();
    expect(mocks.handoffApi.getDefaultDestination).not.toHaveBeenCalled();
  });

  it("a signed-in viewer gets the same button, which opens the hand-off for the card's security", async () => {
    renderControl();
    const button = screen.getByTestId("trade-on-ibkr-button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /submit order/i })).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByTestId("trade-dialog")).toBeTruthy();
    expect(mocks.handoffApi.getEurListings).toHaveBeenCalledWith("sec-msft");
    expect(screen.getByTestId("no-order-notice")).toBeTruthy();
  });
});
