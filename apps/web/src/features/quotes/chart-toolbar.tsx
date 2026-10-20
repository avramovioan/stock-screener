import type { ReactNode } from "react";
import { RANGE_KEYS, type RangeKey } from "./chart-data";
import type { ChartType } from "./std-dev-channel-chart";

const TYPES: { value: ChartType; label: string }[] = [
  { value: "candlestick", label: "Candles" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
];

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function ChartToolbar(props: {
  chartType: ChartType;
  onChartType: (t: ChartType) => void;
  onRange: (r: RangeKey) => void;
  indicatorVisible: boolean;
  onIndicatorToggle: () => void;
  settings: ReactNode;
}) {
  const moveFocus = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const buttons = Array.from(e.currentTarget.parentElement?.querySelectorAll("button") ?? []);
    const i = buttons.indexOf(e.currentTarget);
    const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
    e.preventDefault();
  };
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <div
        role="radiogroup"
        aria-label="Chart type"
        className="inline-flex rounded-md border p-0.5"
      >
        {TYPES.map((t) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control; the brief fixes role="radio" on buttons
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={props.chartType === t.value}
            onClick={() => props.onChartType(t.value)}
            className={`min-h-9 rounded px-3 py-1 text-sm ${FOCUS} ${props.chartType === t.value ? "bg-primary text-primary-foreground underline" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and legend; group of buttons */}
      <div
        role="group"
        aria-label="Visible range (display only)"
        className="inline-flex flex-wrap gap-1"
      >
        {RANGE_KEYS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => props.onRange(r)}
            onKeyDown={moveFocus}
            className={`min-h-9 min-w-10 rounded border px-2 py-1 text-sm ${FOCUS}`}
          >
            {r}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={props.indicatorVisible}
        onClick={props.onIndicatorToggle}
        className={`min-h-9 rounded border px-3 py-1 text-sm ${FOCUS}`}
      >
        {props.indicatorVisible ? "Hide indicator" : "Show indicator"}
      </button>
      {props.settings}
    </div>
  );
}
