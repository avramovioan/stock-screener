import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavChart } from "./nav-chart";

const series = { setData: vi.fn() };
const chart = {
  addSeries: vi.fn(() => series),
  timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  remove: vi.fn(),
};
const createChart = vi.fn(() => chart);
vi.mock("lightweight-charts", () => ({
  createChart: (...a: unknown[]) => (createChart as (...x: unknown[]) => unknown)(...a),
  LineSeries: "line-series",
}));

beforeEach(() => {
  series.setData.mockClear();
  chart.addSeries.mockClear();
  chart.remove.mockClear();
  createChart.mockClear();
});

const points = [
  { date: "2026-10-13", value: 9800.55 },
  { date: "2026-10-14", value: 9950.2 },
];

describe("NavChart", () => {
  it("draws a single line of the NAV when there are at least two statement days", () => {
    const { unmount } = render(<NavChart points={points} currency="EUR" />);
    expect(createChart).toHaveBeenCalledTimes(1);
    expect(chart.addSeries).toHaveBeenCalledWith(
      "line-series",
      expect.objectContaining({ lineWidth: 2 }),
    );
    expect(series.setData).toHaveBeenCalledWith([
      { time: "2026-10-13", value: 9800.55 },
      { time: "2026-10-14", value: 9950.2 },
    ]);
    unmount();
    expect(chart.remove).toHaveBeenCalledTimes(1);
  });

  it("gives screen readers a table alternative with the dates and values", () => {
    render(<NavChart points={points} currency="EUR" />);
    expect(screen.getByRole("table", { name: "NAV history (data)" })).toBeTruthy();
    expect(screen.getByText("9,950.20 EUR")).toBeTruthy();
  });

  it("one row (or none) is not a line: it says so and creates no chart", () => {
    render(<NavChart points={[points[0] as (typeof points)[number]]} currency="EUR" />);
    expect(
      screen.getByText("Not enough NAV history yet: a line needs at least two statement days."),
    ).toBeTruthy();
    expect(createChart).not.toHaveBeenCalled();
  });
});
