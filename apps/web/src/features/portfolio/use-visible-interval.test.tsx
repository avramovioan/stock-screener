import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibleInterval } from "./use-visible-interval";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T07:00:00Z"));
  setVisibility("visible");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useVisibleInterval", () => {
  it("calls the callback every interval while the page is visible", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 300_000));
    vi.advanceTimersByTime(300_000);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses while the page is hidden and does not fire in the background", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 300_000));
    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(1_200_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("on becoming visible runs immediately when the last run is older than the interval, and resumes", () => {
    const cb = vi.fn();
    let last = Date.now();
    renderHook(() => useVisibleInterval(cb, 300_000, { lastRunAt: () => last }));
    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(400_000);
    act(() => setVisibility("visible"));
    expect(cb).toHaveBeenCalledTimes(1);
    last = Date.now();
    vi.advanceTimersByTime(300_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not run immediately when the last run is recent", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 300_000, { lastRunAt: () => Date.now() - 10_000 }));
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops when disabled and clears its timer on unmount", () => {
    const cb = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useVisibleInterval(cb, 1000, { enabled }),
      {
        initialProps: { enabled: false },
      },
    );
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
    rerender({ enabled: true });
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
