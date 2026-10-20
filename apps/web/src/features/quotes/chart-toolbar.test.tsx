import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartToolbar } from "./chart-toolbar";

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof ChartToolbar>[0]> = {}) {
  const props = {
    chartType: "candlestick" as const,
    onChartType: vi.fn(),
    onRange: vi.fn(),
    indicatorVisible: true,
    onIndicatorToggle: vi.fn(),
    settings: <span>settings slot</span>,
    ...over,
  };
  render(<ChartToolbar {...props} />);
  return props;
}

describe("ChartToolbar", () => {
  it("has the eight display-range buttons", () => {
    const p = setup();
    for (const label of ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(p.onRange).toHaveBeenLastCalledWith(label);
    }
  });
  it("arrow keys move focus between range buttons", () => {
    setup();
    const first = screen.getByRole("button", { name: "1D" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "5D" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(first);
  });
  it("chart type is a radiogroup with candlestick, line and area", () => {
    const p = setup();
    expect(screen.getByRole("radio", { name: "Candles" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Area" }));
    expect(p.onChartType).toHaveBeenCalledWith("area");
    fireEvent.click(screen.getByRole("radio", { name: "Line" }));
    expect(p.onChartType).toHaveBeenCalledWith("line");
  });
  it("the indicator toggle states what it will do and reports presses", () => {
    const p = setup();
    const btn = screen.getByRole("button", { name: "Hide indicator" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(p.onIndicatorToggle).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ indicatorVisible: false });
    expect(
      screen.getByRole("button", { name: "Show indicator" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
  it("renders the settings slot", () => {
    setup();
    expect(screen.getByText("settings slot")).toBeTruthy();
  });
});
