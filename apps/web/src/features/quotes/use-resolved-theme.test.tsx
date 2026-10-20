import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useResolvedTheme } from "./use-resolved-theme";

afterEach(() => document.documentElement.classList.remove("dark"));

describe("useResolvedTheme", () => {
  it("reads the dark class and follows changes", async () => {
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
    await act(async () => {
      document.documentElement.classList.add("dark");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBe("dark");
    await act(async () => {
      document.documentElement.classList.remove("dark");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBe("light");
  });
});
