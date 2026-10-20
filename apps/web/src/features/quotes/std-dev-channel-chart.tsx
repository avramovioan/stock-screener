import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import {
  type Bar,
  type ChannelData,
  channelValuesAt,
  defaultViewRange,
  LINE_KEYS,
  type LineKey,
  type RangeKey,
  RIGHT_MARGIN_BARS,
  rangeToLogical,
  whitespaceTimes,
} from "./chart-data";
import { chartPalette, lineStyleFor, type ThemeName } from "./chart-theme";

export type ChartType = "candlestick" | "line" | "area";

export interface CrosshairLegend {
  time: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  value?: number;
  lines: Partial<Record<LineKey, number>>;
}

export interface StdDevChannelChartProps {
  bars: Bar[];
  channel: ChannelData;
  chartType: ChartType;
  indicatorVisible: boolean;
  lineVisibility: Record<LineKey, boolean>;
  theme: ThemeName;
  rangeRequest: { range: RangeKey; nonce: number } | null;
  ariaLabel: string;
  onLegend?: (legend: CrosshairLegend | null) => void;
}

type MainSeries = ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;

function themeOptions(theme: ThemeName) {
  const pal = chartPalette(theme);
  return {
    layout: {
      background: { type: ColorType.Solid, color: pal.background },
      textColor: pal.text,
      attributionLogo: true,
    },
    grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
    rightPriceScale: { borderColor: pal.border },
    timeScale: { borderColor: pal.border },
  };
}

/**
 * Lightweight Charts 5.2.1 wrapper. The five channel lines are separate LineSeries with three real
 * points each (left, right, +126-bar extension on the segment's own slope); whitespace points on the
 * main series create the future x-axis. attributionLogo stays enabled (licence).
 */
export function StdDevChannelChart(props: StdDevChannelChartProps) {
  const {
    bars,
    channel,
    chartType,
    indicatorVisible,
    lineVisibility,
    theme,
    rangeRequest,
    ariaLabel,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<MainSeries | null>(null);
  const lineRefs = useRef(new Map<LineKey, ISeriesApi<"Line">>());
  const onLegendRef = useRef(props.onLegend);
  onLegendRef.current = props.onLegend;
  // Latest data for the crosshair handler (the chart is created once).
  const legendDataRef = useRef({
    channel,
    indicatorVisible,
    lineVisibility,
    barCount: bars.length,
  });
  legendDataRef.current = { channel, indicatorVisible, lineVisibility, barCount: bars.length };

  // 1. Create once; cleanup handles React Strict Mode double mounting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart is created once; later effects apply changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      ...themeOptions(theme),
      timeScale: { ...themeOptions(theme).timeScale, rightOffset: RIGHT_MARGIN_BARS },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;
    const onMove = (p: MouseEventParams<Time>) => {
      if (!p.time || !p.seriesData) {
        onLegendRef.current?.(null);
        return;
      }
      const legend: CrosshairLegend = { time: String(p.time), lines: {} };
      const main = mainRef.current;
      const d = main ? (p.seriesData.get(main) as Record<string, unknown> | undefined) : undefined;
      if (d && "open" in d) {
        legend.open = d.open as number;
        legend.high = d.high as number;
        legend.low = d.low as number;
        legend.close = d.close as number;
      } else if (d && "value" in d) {
        legend.value = d.value as number;
      }
      const ld = legendDataRef.current;
      if (ld.indicatorVisible && p.logical !== undefined) {
        const values = channelValuesAt(ld.channel, ld.barCount, p.logical);
        for (const key of LINE_KEYS) {
          const v = values[key];
          if (ld.lineVisibility[key] && v !== undefined) legend.lines[key] = v;
        }
      }
      onLegendRef.current?.(legend);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      lineRefs.current.clear();
    };
  }, []);

  // 2. Theme: derived colours are re-applied on change.
  useEffect(() => {
    chartRef.current?.applyOptions(themeOptions(theme));
  }, [theme]);

  // 3. Main series (candlestick / line / area) plus whitespace for the future axis.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (mainRef.current) {
      chart.removeSeries(mainRef.current);
      mainRef.current = null;
    }
    const pal = chartPalette(theme);
    const future = whitespaceTimes(bars).map((time) => ({ time: time as Time }));
    if (chartType === "candlestick") {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: pal.up,
        downColor: pal.down,
        wickUpColor: pal.up,
        wickDownColor: pal.down,
        borderVisible: false,
      });
      s.setData([
        ...bars.map((b) => ({
          time: b.time as Time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
        ...future,
      ]);
      mainRef.current = s;
    } else if (chartType === "line") {
      const s = chart.addSeries(LineSeries, { color: pal.line, lineWidth: 2 });
      s.setData([...bars.map((b) => ({ time: b.time as Time, value: b.close })), ...future]);
      mainRef.current = s;
    } else {
      const s = chart.addSeries(AreaSeries, {
        lineColor: pal.line,
        topColor: pal.areaTop,
        bottomColor: pal.areaBottom,
        lineWidth: 2,
      });
      s.setData([...bars.map((b) => ({ time: b.time as Time, value: b.close })), ...future]);
      mainRef.current = s;
    }
  }, [bars, chartType, theme]);

  // 4. Channel lines: removed and re-created on toggle, visibility, data, type or theme change
  //    (re-created after the main series so the lines stay on top).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chartType and bars are re-creation triggers (z-order after the main series)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of lineRefs.current.values()) chart.removeSeries(s);
    lineRefs.current.clear();
    if (!indicatorVisible || channel.status !== "ok") return;
    for (const line of channel.lines) {
      if (!lineVisibility[line.key]) continue;
      const style = lineStyleFor(line.key, theme);
      const s = chart.addSeries(LineSeries, {
        color: style.color,
        lineWidth: 1,
        lineStyle: style.dash === "large" ? LineStyle.LargeDashed : LineStyle.Dashed,
        title: line.title,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(line.points.map((p) => ({ time: p.time as Time, value: p.value })));
      lineRefs.current.set(line.key, s);
    }
  }, [channel, indicatorVisible, lineVisibility, theme, chartType, bars]);

  // 5. Visible range: ten-year default for a new instrument, then range buttons (display only).
  useEffect(() => {
    const range = defaultViewRange(bars);
    if (range) chartRef.current?.timeScale().setVisibleLogicalRange(range);
  }, [bars]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request (nonce) re-applies a range
  useEffect(() => {
    if (!rangeRequest) return;
    const range = rangeToLogical(rangeRequest.range, bars);
    if (range) chartRef.current?.timeScale().setVisibleLogicalRange(range);
  }, [rangeRequest?.nonce]);

  return (
    // role="img" is invalid here: the chart library renders focusable internals (axe nested-interactive)
    // biome-ignore lint/a11y/useSemanticElements: a fieldset cannot host the chart canvas container
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      className="h-[320px] w-full overflow-hidden rounded-md border sm:h-[420px]"
    />
  );
}
