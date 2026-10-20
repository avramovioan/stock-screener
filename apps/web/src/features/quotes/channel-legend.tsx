import { formatMoney } from "@/lib/format";
import { LINE_KEYS, LINE_TITLES } from "./chart-data";
import type { CrosshairLegend } from "./std-dev-channel-chart";

/** OHLC and channel values under the crosshair (live region off: it changes on every mouse move). */
export function ChannelLegend({
  legend,
  currency,
}: {
  legend: CrosshairLegend | null;
  currency: string;
}) {
  if (!legend) {
    return (
      <p className="min-h-5 text-xs text-muted-foreground">
        Move the pointer over the chart for values.
      </p>
    );
  }
  const f = (v: number | undefined) => (v === undefined ? "n/a" : formatMoney(v, currency));
  return (
    <p className="min-h-5 text-xs tabular-nums" data-testid="channel-legend">
      <span>{legend.time}</span>
      {legend.close !== undefined ? (
        <span>{` · O ${f(legend.open)} H ${f(legend.high)} L ${f(legend.low)} C ${f(legend.close)}`}</span>
      ) : (
        <span>{` · ${f(legend.value)}`}</span>
      )}
      {LINE_KEYS.map((k) =>
        legend.lines[k] !== undefined ? (
          <span key={k}>{` · ${LINE_TITLES[k]} ${f(legend.lines[k])}`}</span>
        ) : null,
      )}
    </p>
  );
}
