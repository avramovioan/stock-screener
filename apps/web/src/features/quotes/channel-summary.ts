import type { Channel } from "@core/indicator.ts";

/** Text alternative for the chart (screen readers). */
export function describeChannel(p: { close: number; date: string; channel: Channel }): string {
  const line = p.channel.end.lower1;
  const pct = (p.close / line - 1) * 100;
  const where = `${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? "above" : "below"}`;
  const trend = p.channel.rising ? "rising" : "falling";
  return `Last close ${p.close.toFixed(2)} on ${p.date} is ${where} the -3 line (${line.toFixed(2)}); the channel is ${trend}.`;
}
