import { describe, expect, it } from "vitest";
import { closeLabelCentrePx, closeLabelHalf, closeLabelLeft, mirrorPos } from "./close-label";

const TEXT = "$398.00"; // 7 chars, 52.5px estimated, half 26.25px
const GAUGE = 300;

describe("close label clamping", () => {
  it("aligns the label's left edge to 0 when the close sits near the left edge", () => {
    const centre = closeLabelCentrePx(GAUGE, 2, TEXT);
    expect(centre - closeLabelHalf(TEXT)).toBe(0);
  });

  it("aligns the label's right edge to 100% when the close sits near the right edge", () => {
    const centre = closeLabelCentrePx(GAUGE, 99, TEXT);
    expect(centre + closeLabelHalf(TEXT)).toBe(GAUGE);
  });

  it("keeps the label centred on the close otherwise", () => {
    expect(closeLabelCentrePx(GAUGE, 50, TEXT)).toBe(150);
  });

  it("emits the matching CSS clamp, centred at the close position", () => {
    expect(closeLabelLeft(40, TEXT)).toBe("clamp(26.25px, 40%, calc(100% - 26.25px))");
  });

  it("mirrors a position across the bar, so the −3 line sits left and the −4 line right", () => {
    expect(mirrorPos(0)).toBe(100);
    expect(mirrorPos(30)).toBe(70);
    expect(mirrorPos(mirrorPos(12.5))).toBe(12.5);
  });
});
