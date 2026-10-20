/** Conservative width of one character of the close label (text-xs, semibold, tabular figures), in px. */
const CHAR_PX = 7.5;

/** Flips a 0-100 position across the bar: the gauge reads −3 on the left and −4 on the right, so price falls to the right. */
export function mirrorPos(pos: number): number {
  return 100 - pos;
}

/** Half of the label's estimated width, in px. */
export function closeLabelHalf(text: string): number {
  return (text.length * CHAR_PX) / 2;
}

/**
 * CSS `left` for the close label, which is centred on its anchor with `translateX(-50%)`: the anchor is the close position, held at least
 * half a label from the left edge and half a label from the right edge, so the label stays inside the gauge.
 */
export function closeLabelLeft(closePos: number, text: string): string {
  const half = closeLabelHalf(text);
  return `clamp(${half}px, ${closePos}%, calc(100% - ${half}px))`;
}

/** The same clamp in pixels, for a gauge `gaugePx` wide: where the label's centre lands. */
export function closeLabelCentrePx(gaugePx: number, closePos: number, text: string): number {
  const half = closeLabelHalf(text);
  return Math.min(Math.max((closePos / 100) * gaugePx, half), gaugePx - half);
}
