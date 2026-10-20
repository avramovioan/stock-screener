import { valueAt } from "@core/indicator.ts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBars } from "@/test/bars";

const h = vi.hoisted(() => {
  const makeSeries = () => ({ setData: vi.fn(), applyOptions: vi.fn() });
  const timeScale = { setVisibleLogicalRange: vi.fn(), applyOptions: vi.fn() };
  const chart = {
    addSeries: vi.fn((_def: unknown, _opts?: unknown) => makeSeries()),
    removeSeries: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: vi.fn(() => timeScale),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    remove: vi.fn(),
  };
  return { chart, timeScale, createChart: vi.fn((_el: unknown, _opts: unknown) => chart) };
});
vi.mock("lightweight-charts", () => ({
  createChart: h.createChart,
  CandlestickSeries: "CandlestickSeries",
  LineSeries: "LineSeries",
  AreaSeries: "AreaSeries",
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Dashed: 2, LargeDashed: 3 },
}));

import { type ChannelData, computeChannelData } from "./chart-data";
import { StdDevChannelChart } from "./std-dev-channel-chart";

const bars = makeBars(2600);
const channel = computeChannelData(bars);
const ALL = { upper2: true, upper1: true, base: true, lower1: true, lower2: true };
type Props = Parameters<typeof StdDevChannelChart>[0];
const base = (over: Partial<Props> = {}): Props => ({
  bars,
  channel,
  chartType: "candlestick",
  indicatorVisible: true,
  lineVisibility: ALL,
  theme: "light",
  rangeRequest: null,
  ariaLabel: "Price chart",
  ...over,
});
const seriesCalls = (def: string) => h.chart.addSeries.mock.calls.filter((c) => c[0] === def);

beforeEach(() => {
  for (const f of [
    h.chart.addSeries,
    h.chart.removeSeries,
    h.chart.applyOptions,
    h.chart.remove,
    h.createChart,
    h.timeScale.setVisibleLogicalRange,
  ]) {
    f.mockClear();
  }
});
afterEach(cleanup);

describe("StdDevChannelChart", () => {
  it("creates the chart keeping the TradingView attribution logo and a 12-bar right margin", () => {
    render(<StdDevChannelChart {...base()} />);
    expect(h.createChart).toHaveBeenCalledTimes(1);
    const opts = h.createChart.mock.calls[0]?.[1] as {
      layout: { attributionLogo: boolean };
      timeScale: { rightOffset: number };
    };
    expect(opts.layout.attributionLogo).toBe(true);
    expect(opts.timeScale.rightOffset).toBe(12);
  });

  it("creates one candlestick series fed with the bars plus 126 whitespace points", () => {
    render(<StdDevChannelChart {...base()} />);
    expect(seriesCalls("CandlestickSeries")).toHaveLength(1);
    const main = h.chart.addSeries.mock.results[0]?.value as { setData: ReturnType<typeof vi.fn> };
    const data = main.setData.mock.calls[0]?.[0] as { time: string; close?: number }[];
    expect(data).toHaveLength(2600 + 126);
    expect(data[2599]?.close).toBeDefined();
    expect(data[2600]).toEqual({ time: data[2600]?.time }); // whitespace: time only
  });

  it("creates five channel line series with titles +2, +1, Base, -3, -4 and three points each", () => {
    render(<StdDevChannelChart {...base()} />);
    const lines = seriesCalls("LineSeries");
    expect(lines).toHaveLength(5);
    expect(lines.map((c) => (c[1] as { title: string }).title)).toEqual([
      "+2",
      "+1",
      "Base",
      "-3",
      "-4",
    ]);
    const opts = lines.map((c) => c[1] as { lineWidth: number; lineStyle: number });
    for (const o of opts) expect(o.lineWidth).toBe(1);
    expect(opts[0]?.lineStyle).toBe(3); // set 2: large dash
    expect(opts[1]?.lineStyle).toBe(2); // set 1: dashed
    const first = h.chart.addSeries.mock.results.find(
      (_r, i) => h.chart.addSeries.mock.calls[i]?.[0] === "LineSeries",
    );
    const firstSeries = first?.value as { setData: ReturnType<typeof vi.fn> };
    expect(firstSeries.setData.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("toggling the indicator off removes the five series and on re-adds them", () => {
    const { rerender } = render(<StdDevChannelChart {...base()} />);
    expect(h.chart.removeSeries).not.toHaveBeenCalled();
    rerender(<StdDevChannelChart {...base({ indicatorVisible: false })} />);
    expect(h.chart.removeSeries).toHaveBeenCalledTimes(5);
    expect(seriesCalls("LineSeries")).toHaveLength(5); // no new line series while hidden
    rerender(<StdDevChannelChart {...base({ indicatorVisible: true })} />);
    expect(seriesCalls("LineSeries")).toHaveLength(10);
  });

  it("per-line visibility: a hidden line is not created", () => {
    render(<StdDevChannelChart {...base({ lineVisibility: { ...ALL, base: false } })} />);
    const titles = seriesCalls("LineSeries").map((c) => (c[1] as { title: string }).title);
    expect(titles).toEqual(["+2", "+1", "-3", "-4"]);
  });

  it("insufficient history draws no lines", () => {
    render(
      <StdDevChannelChart
        {...base({
          channel: { status: "insufficient", have: 100, need: 2500 } satisfies ChannelData,
        })}
      />,
    );
    expect(seriesCalls("LineSeries")).toHaveLength(0);
    expect(seriesCalls("CandlestickSeries")).toHaveLength(1);
  });

  it("switching the chart type replaces only the main series (area here)", () => {
    const { rerender } = render(<StdDevChannelChart {...base()} />);
    rerender(<StdDevChannelChart {...base({ chartType: "area" })} />);
    expect(seriesCalls("AreaSeries")).toHaveLength(1);
    expect(h.chart.removeSeries).toHaveBeenCalled();
  });

  it("applies the default ten-year view, then a requested range ending at lastIndex + 12", () => {
    const { rerender } = render(<StdDevChannelChart {...base()} />);
    const initial = h.timeScale.setVisibleLogicalRange.mock.calls.at(-1)?.[0] as {
      from: number;
      to: number;
    };
    expect(initial.to).toBe(2599 + 12);
    rerender(<StdDevChannelChart {...base({ rangeRequest: { range: "5D", nonce: 1 } })} />);
    expect(h.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 2595, to: 2611 });
    rerender(<StdDevChannelChart {...base({ rangeRequest: { range: "1D", nonce: 2 } })} />);
    expect(h.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 2598, to: 2611 });
  });

  it("re-applies colours when the theme changes", () => {
    const { rerender } = render(<StdDevChannelChart {...base()} />);
    h.chart.applyOptions.mockClear();
    rerender(<StdDevChannelChart {...base({ theme: "dark" })} />);
    const arg = h.chart.applyOptions.mock.calls.at(-1)?.[0] as {
      layout: { background: { color: string } };
    };
    expect(arg.layout.background.color).toBe("#0f1115");
  });

  it("legend channel values come from valueAt at the crosshair index, not from the 3-point series", () => {
    const onLegend = vi.fn();
    render(<StdDevChannelChart {...base({ onLegend })} />);
    const onMove = h.chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (p: unknown) => void;
    // 2600 bars, 2500-bar window: logical 1300 is window index 1200, far from the 3 stored points.
    onMove({ time: "2021-01-01", logical: 1300, seriesData: new Map() });
    const legend = onLegend.mock.calls.at(-1)?.[0] as { lines: Record<string, number> };
    if (channel.status !== "ok") throw new Error("expected ok");
    const c = channel.channel;
    expect(Object.keys(legend.lines).sort()).toEqual([
      "base",
      "lower1",
      "lower2",
      "upper1",
      "upper2",
    ]);
    expect(legend.lines.base).toBeCloseTo(valueAt(c.base, 1200), 9);
    expect(legend.lines.upper1).toBeCloseTo(valueAt(c.upper1, 1200), 9);
    expect(legend.lines.lower1).toBeCloseTo(valueAt(c.lower1, 1200), 9);
    expect(legend.lines.upper2).toBeCloseTo(valueAt(c.upper2, 1200), 9);
    expect(legend.lines.lower2).toBeCloseTo(valueAt(c.lower2, 1200), 9);
  });

  it("channel line series do not show the projected value as an axis tag", () => {
    render(<StdDevChannelChart {...base()} />);
    for (const c of seriesCalls("LineSeries")) {
      expect((c[1] as { lastValueVisible: boolean }).lastValueVisible).toBe(false);
    }
  });

  it("removes the chart on unmount", () => {
    const { unmount } = render(<StdDevChannelChart {...base()} />);
    unmount();
    expect(h.chart.remove).toHaveBeenCalledTimes(1);
  });

  it("exposes a text alternative", () => {
    const { getByRole } = render(
      <StdDevChannelChart {...base({ ariaLabel: "Chart: last close 123" })} />,
    );
    expect(getByRole("group", { name: "Chart: last close 123" })).toBeTruthy();
  });
});
