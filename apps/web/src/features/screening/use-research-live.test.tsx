import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "./hooks";
import { type LiveClient, useResearchLive } from "./use-research-live";

type Handler = () => void;
let handler: Handler | null;
let statusCb: ((status: string) => void) | null;
const channel = {
  on: vi.fn((_type: string, _filter: unknown, cb: Handler) => {
    handler = cb;
    return channel;
  }),
  subscribe: vi.fn((cb?: (status: string) => void) => {
    statusCb = cb ?? null;
    return channel;
  }),
};
const client = {
  channel: vi.fn(() => channel),
  removeChannel: vi.fn(),
} satisfies LiveClient;

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  handler = null;
  statusCb = null;
  queryClient = new QueryClient();
  vi.spyOn(queryClient, "invalidateQueries");
  for (const m of [client.channel, client.removeChannel, channel.on, channel.subscribe])
    m.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useResearchLive", () => {
  it("subscribes once to inserts and updates of research_reports", () => {
    const { rerender } = renderHook(() => useResearchLive(client), { wrapper });
    rerender();
    expect(client.channel).toHaveBeenCalledTimes(1);
    for (const event of ["INSERT", "UPDATE"]) {
      expect(channel.on).toHaveBeenCalledWith(
        "postgres_changes",
        { event, schema: "public", table: "research_reports" },
        expect.any(Function),
      );
    }
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
  });

  it("invalidates the feed and the quota once, one second after a burst of events", () => {
    renderHook(() => useResearchLive(client), { wrapper });
    act(() => {
      handler?.();
      vi.advanceTimersByTime(400);
      handler?.();
      vi.advanceTimersByTime(900);
    });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.discounts });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.researchQuota,
    });
  });

  it("unsubscribes and drops a pending refresh on unmount", () => {
    const { unmount } = renderHook(() => useResearchLive(client), { wrapper });
    act(() => handler?.());
    unmount();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    act(() => vi.advanceTimersByTime(2000));
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it("a failed channel or a throwing client breaks nothing", () => {
    renderHook(() => useResearchLive(client), { wrapper });
    expect(() => act(() => statusCb?.("CHANNEL_ERROR"))).not.toThrow();
    const broken = {
      channel: () => {
        throw new Error("no websocket");
      },
      removeChannel: vi.fn(),
    } satisfies LiveClient;
    expect(() => renderHook(() => useResearchLive(broken), { wrapper })).not.toThrow();
  });
});
