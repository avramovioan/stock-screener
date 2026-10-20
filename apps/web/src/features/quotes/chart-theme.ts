import type { LineKey } from "./chart-data";

export type ThemeName = "light" | "dark";

/** Hex only: the chart library parses hex, rgb and hsl but not oklch. Re-applied on theme change. */
export function chartPalette(theme: ThemeName) {
  return theme === "dark"
    ? {
        background: "#0f1115",
        text: "#d5dae2",
        grid: "#232830",
        border: "#3a4250",
        up: "#4ade80",
        down: "#f87171",
        line: "#60a5fa",
        areaTop: "#3b82f6",
        areaBottom: "#0f1115",
      }
    : {
        background: "#ffffff",
        text: "#1f2937",
        grid: "#e5e7eb",
        border: "#9ca3af",
        up: "#15803d",
        down: "#b91c1c",
        line: "#1d4ed8",
        areaTop: "#2563eb",
        areaBottom: "#ffffff",
      };
}

const COLORS: Record<ThemeName, { orange: string; blue: string; green: string }> = {
  light: { orange: "#c2410c", blue: "#1d4ed8", green: "#15803d" },
  dark: { orange: "#fb923c", blue: "#60a5fa", green: "#4ade80" },
};

export function lineStyleFor(
  key: LineKey,
  theme: ThemeName,
): { color: string; dash: "dashed" | "large" } {
  const c = COLORS[theme];
  switch (key) {
    case "base":
    case "lower1":
      return { color: c.orange, dash: "dashed" };
    case "upper1":
      return { color: c.blue, dash: "dashed" };
    default:
      return { color: c.green, dash: "large" }; // set 2: upper2 and lower2
  }
}
