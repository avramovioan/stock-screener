import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./theme-provider";

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <output data-testid="theme">{theme}</output>
      <output data-testid="resolved">{resolvedTheme}</output>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
    </div>
  );
}

const renderProbe = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ThemeProvider", () => {
  it("defaults to system and follows prefers-color-scheme", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists an explicit choice and toggles the dark class", () => {
    renderProbe();
    fireEvent.click(screen.getByText("dark"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.click(screen.getByText("light"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("reads a stored theme on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  it("survives storage that throws (private windows)", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    });
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(() => fireEvent.click(screen.getByText("dark"))).not.toThrow();
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
});
