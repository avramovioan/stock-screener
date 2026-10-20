import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerRun } from "../broker/broker-api";
import { useStatementSync } from "./use-statement-sync";

const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, info: toastInfo, success: vi.fn() } }));
const readSnapshot = vi.fn();
const sync = vi.fn();
vi.mock("@/features/broker/default", () => ({
  brokerApi: {
    readSnapshot: (...a: unknown[]) => readSnapshot(...a),
    sync: (...a: unknown[]) => sync(...a),
  },
}));

const run = (state: BrokerRun["state"], over: Partial<BrokerRun> = {}): BrokerRun => ({
  id: "run-1",
  kind: "manual",
  state,
  error_code: null,
  error_message: null,
  rows_summary: {},
  ...over,
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useStatementSync(), { wrapper }), invalidate };
}

beforeEach(() => {
  readSnapshot.mockReset();
  sync.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  readSnapshot.mockResolvedValue({ connection: null, run: null });
});

describe("useStatementSync", () => {
  it("is idle at first", async () => {
    const { result } = setup();
    await waitFor(() => expect(readSnapshot).toHaveBeenCalled());
    expect(result.current.active).toBe(false);
    expect(result.current.syncedAt).toBeNull();
    expect(result.current.nextAt).toBeNull();
  });

  it("is active while a run is in progress", async () => {
    readSnapshot.mockResolvedValue({ connection: null, run: run("polling") });
    const { result } = setup();
    await waitFor(() => expect(result.current.active).toBe(true));
  });

  it("when the run is done it refetches holdings and trades and records the time", async () => {
    sync.mockResolvedValue({ ok: true, connection: null, run: run("queued") });
    const { result, invalidate } = setup();
    await act(async () => void (await result.current.start()));
    readSnapshot.mockResolvedValue({ connection: null, run: run("done") });
    await act(async () => {
      await result.current.refreshSnapshot();
    });
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["portfolio"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["holdingLinks"] });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("the cooldown answer shows a visible toast with the next time and exposes it for the title", async () => {
    sync.mockResolvedValue({ ok: false, kind: "cooldown", retryAfterSeconds: 540 });
    const { result } = setup();
    await act(async () => void (await result.current.start()));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo.mock.calls[0]?.[0]).toMatch(/^Statement synced recently; next at /);
    expect(result.current.nextAt).not.toBeNull();
    expect(result.current.nextNotice).toMatch(/^Statement synced recently; next at /);
  });

  it("a failed run shows exactly one error toast with the run's message", async () => {
    sync.mockResolvedValue({ ok: true, connection: null, run: run("queued") });
    const { result } = setup();
    await act(async () => void (await result.current.start()));
    readSnapshot.mockResolvedValue({
      connection: null,
      run: run("failed", { error_message: "IBKR rejected the query." }),
    });
    await act(async () => {
      await result.current.refreshSnapshot();
    });
    await act(async () => {
      await result.current.refreshSnapshot();
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("IBKR rejected the query.");
  });

  it("an expired run reports the token expiry once", async () => {
    sync.mockResolvedValue({ ok: true, connection: null, run: run("queued") });
    const { result } = setup();
    await act(async () => void (await result.current.start()));
    readSnapshot.mockResolvedValue({ connection: null, run: run("expired") });
    await act(async () => {
      await result.current.refreshSnapshot();
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  });

  it("a request that fails outright shows an error toast", async () => {
    sync.mockResolvedValue({ ok: false, kind: "failed", message: "Network error." });
    const { result } = setup();
    await act(async () => void (await result.current.start()));
    expect(toastError).toHaveBeenCalledWith("Network error.");
  });

  it("a run started elsewhere that finishes while the page is open refetches and announces", async () => {
    readSnapshot.mockResolvedValue({ connection: null, run: run("polling", { id: "other" }) });
    const { result, invalidate } = setup();
    await waitFor(() => expect(result.current.active).toBe(true));
    readSnapshot.mockResolvedValue({ connection: null, run: run("done", { id: "other" }) });
    await act(async () => {
      await result.current.refreshSnapshot();
    });
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["portfolio"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["holdingLinks"] });
  });

  it("the cooldown notice expires when the cooldown ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      sync.mockResolvedValue({ ok: false, kind: "cooldown", retryAfterSeconds: 540 });
      const { result } = setup();
      await act(async () => void (await result.current.start()));
      expect(result.current.nextNotice).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(541_000);
      });
      expect(result.current.nextAt).toBeNull();
      expect(result.current.nextNotice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
