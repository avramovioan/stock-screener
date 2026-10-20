import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPortfolio } from "./portfolio-api";
import { PORTFOLIO_KEY, usePortfolio } from "./use-portfolio";

const get = vi.fn();
vi.mock("./default", () => ({
  portfolioApi: { get: (...a: unknown[]) => get(...a), refresh: vi.fn() },
}));

const data = (marker: string): ClientPortfolio =>
  ({
    serverTime: "2026-10-15T07:00:00.000Z",
    nextAutoRefreshAt: "2026-10-15T07:05:00.000Z",
    manualAvailableAt: "2026-10-15T07:00:00.000Z",
    lastSuccessfulAt: marker,
    receivedAtMs: 0,
    view: { positions: [] },
  }) as never;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  get.mockReset();
  setVisibility("visible");
});
afterEach(() => vi.useRealTimers());

describe("usePortfolio", () => {
  it("fetches on mount and exposes the data", async () => {
    get.mockResolvedValue(data("a"));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePortfolio(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.lastSuccessfulAt).toBe("a"));
  });

  it("refetches every five minutes while visible and not while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockResolvedValue(data("a"));
    const { Wrapper } = wrapper();
    renderHook(() => usePortfolio(), { wrapper: Wrapper });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("a failed refresh keeps the last successful data and reports the error (never zeros)", async () => {
    get.mockResolvedValueOnce(data("good"));
    get.mockRejectedValue(new Error("Network error"));
    const { Wrapper, client } = wrapper();
    // TanStack Query only re-renders for the result properties a consumer reads, like the screens do with isError/error
    const { result } = renderHook(
      () => {
        const query = usePortfolio();
        void query.isError;
        return query;
      },
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.data?.lastSuccessfulAt).toBe("good"));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.lastSuccessfulAt).toBe("good");
    expect(client.getQueryData<ClientPortfolio>(PORTFOLIO_KEY)?.lastSuccessfulAt).toBe("good");
  });

  it("does nothing while disabled", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => usePortfolio({ enabled: false }), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });
});
