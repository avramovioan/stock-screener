import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientPortfolio, CooldownError } from "./portfolio-api";
import { useManualRefresh } from "./use-manual-refresh";
import { PORTFOLIO_KEY } from "./use-portfolio";

const refresh = vi.fn();
vi.mock("./default", () => ({
  portfolioApi: { get: vi.fn(), refresh: (...a: unknown[]) => refresh(...a) },
}));

const NOW = new Date("2026-10-15T07:00:00.000Z");
const payload = (over: Partial<ClientPortfolio> = {}): ClientPortfolio =>
  ({
    serverTime: NOW.toISOString(),
    manualAvailableAt: new Date(NOW.getTime() + 60_000).toISOString(),
    receivedAtMs: NOW.getTime(),
    view: { positions: [] },
    ...over,
  }) as never;

function setup(initial?: ClientPortfolio) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (initial !== undefined) client.setQueryData(PORTFOLIO_KEY, initial);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useManualRefresh(), { wrapper }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  refresh.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useManualRefresh (client cooldown mirrors the server's 60 s)", () => {
  it("is available when the server says so", () => {
    const { result } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.available).toBe(true);
  });

  it("a successful refresh starts a 60 s countdown from the server's manualAvailableAt and counts down", async () => {
    refresh.mockResolvedValue(payload());
    const { result, client } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<ClientPortfolio>(PORTFOLIO_KEY)?.manualAvailableAt).toBe(
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    expect(result.current.secondsLeft).toBe(60);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(result.current.secondsLeft).toBe(15);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.available).toBe(true);
  });

  it("ignores clicks during the countdown and while a refresh is running (no overlapping requests)", async () => {
    let release: (v: ClientPortfolio) => void = () => undefined;
    refresh.mockImplementation(() => new Promise<ClientPortfolio>((r) => (release = r)));
    const { result } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.refresh();
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      release(payload());
      await first;
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a server 429 sets the countdown from Retry-After and keeps the data", async () => {
    refresh.mockRejectedValue(new CooldownError(37));
    const { result, client } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.secondsLeft).toBe(37);
    expect(result.current.error).toBeNull();
    expect(client.getQueryData(PORTFOLIO_KEY)).toBeDefined();
  });

  it("another failure keeps the data, reports the message and does not start a cooldown", async () => {
    refresh.mockRejectedValue(new Error("Network error: could not reach the server."));
    const { result, client } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("Network error: could not reach the server.");
    expect(result.current.secondsLeft).toBe(0);
    expect(client.getQueryData<ClientPortfolio>(PORTFOLIO_KEY)?.serverTime).toBe(NOW.toISOString());
  });

  it("the countdown follows the server clock when the local clock is skewed", () => {
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    const { result } = setup(payload({ receivedAtMs: NOW.getTime() + 3_600_000 }));
    expect(result.current.secondsLeft).toBe(60);
  });

  it("invalidates the analytics history only when the refresh returns a new statement day", async () => {
    const { result, client } = setup(
      payload({ manualAvailableAt: NOW.toISOString(), reportDate: "2026-10-14" }),
    );
    const spy = vi.spyOn(client, "invalidateQueries");
    refresh.mockResolvedValue(payload({ reportDate: "2026-10-14" }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.succeededAt).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    refresh.mockResolvedValue(payload({ reportDate: "2026-10-15" }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["analytics", "data"] });
  });
});
