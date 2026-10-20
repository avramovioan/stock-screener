import type { Series } from "../../_shared/core/bars.ts";

/**
 * Mean traded value in USD over the last `window` completed bars: (close / minorDivisor) * volume * usdPerUnit.
 * The price is in the quote unit (GBp), so it is converted to the major unit before FX. Null when there are no bars.
 */
export function averageUsdVolume(
  series: Series,
  minorDivisor: number,
  usdPerUnit: number,
  window = 30,
): number | null {
  const n = series.close.length;
  if (n === 0) return null;
  const from = Math.max(0, n - window);
  let sum = 0;
  for (let i = from; i < n; i++)
    sum += ((series.close[i] as number) / minorDivisor) * (series.volume[i] as number) * usdPerUnit;
  return sum / (n - from);
}
