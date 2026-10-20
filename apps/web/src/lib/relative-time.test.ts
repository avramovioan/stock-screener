import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relativeTime, useNow } from "./relative-time";

const NOW = new Date("2026-10-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("under a minute is just now", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59_000), NOW)).toBe("just now");
  });
  it("a time in the future is just now", () => {
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe("just now");
  });
  it("minutes, singular and plural", () => {
    expect(relativeTime(ago(MIN), NOW)).toBe("1 minute ago");
    expect(relativeTime(ago(2 * MIN), NOW)).toBe("2 minutes ago");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59 minutes ago");
  });
  it("hours, singular and plural", () => {
    expect(relativeTime(ago(60 * MIN), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2 hours ago");
    expect(relativeTime(ago(23 * HOUR + 59 * MIN), NOW)).toBe("23 hours ago");
  });
  it("days, singular and plural", () => {
    expect(relativeTime(ago(24 * HOUR), NOW)).toBe("1 day ago");
    expect(relativeTime(ago(47 * HOUR), NOW)).toBe("1 day ago");
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3 days ago");
  });
  it("an invalid date is empty", () => {
    expect(relativeTime("nope", NOW)).toBe("");
  });
});

describe("useNow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("refreshes every minute", () => {
    vi.setSystemTime(NOW);
    const { result } = renderHook(() => useNow());
    const first = result.current.getTime();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.getTime()).toBe(first + 60_000);
  });
});
