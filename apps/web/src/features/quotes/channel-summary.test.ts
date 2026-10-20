import { DEFAULT_SETTINGS } from "@core/indicator.ts";
import { describe, expect, it } from "vitest";
import { makeBars } from "@/test/bars";
import { describeChannel } from "./channel-summary";
import { computeChannelData } from "./chart-data";

describe("describeChannel", () => {
  const bars = makeBars(30, "2026-08-03", (i) => 10 + i);
  const r = computeChannelData(bars, { ...DEFAULT_SETTINGS, length: 20 });
  if (r.status !== "ok") throw new Error("expected ok");

  it("says above the -3 line and rising", () => {
    const channel = { ...r.channel, end: { ...r.channel.end, lower1: 120.9 }, rising: true };
    expect(describeChannel({ close: 123.4, date: "2026-10-14", channel })).toBe(
      "Last close 123.40 on 2026-10-14 is 2.1% above the -3 line (120.90); the channel is rising.",
    );
  });
  it("says below the -3 line and falling", () => {
    const channel = { ...r.channel, end: { ...r.channel.end, lower1: 105 }, rising: false };
    expect(describeChannel({ close: 100, date: "2026-10-14", channel })).toBe(
      "Last close 100.00 on 2026-10-14 is 4.8% below the -3 line (105.00); the channel is falling.",
    );
  });
});
