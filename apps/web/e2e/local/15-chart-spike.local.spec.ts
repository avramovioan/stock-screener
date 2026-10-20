/**
 * Browser spike P4-01 (real Chromium, real Lightweight Charts 5.2.1, no stubs): the five channel lines extend 126 weekday bars past the
 * last candle and are really painted there, and the TradingView attribution logo renders inside the chart.
 *
 * The chart handle is read from the React fiber of the chart container (the wrapper keeps the IChartApi and the line series in refs), then
 * only the library's public API is used: series.data(), timeScale().timeToCoordinate(), series.priceToCoordinate(). The painted pixels are
 * read back from the chart canvases with getImageData, at the end of each line and (as a negative control) just beyond it.
 */
import { expect, test } from "@playwright/test";

interface LineEvidence {
  key: string;
  points: number;
  lastTime: string;
  lastValue: number;
  color: string;
  extensionBars: number;
  xEnd: number;
  paintedBeforeEnd: number;
  paintedAfterEnd: number;
}
interface Evidence {
  lastCandle: string;
  lines: LineEvidence[];
  logo: { href: string | null; visible: boolean; hasSvg: boolean } | null;
}

test("the five channel lines extend 126 bars past the last candle and are painted there; the TradingView logo renders", async ({
  page,
}) => {
  await page.goto("/quotes?symbol=AAPL");
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByText(/Last completed close/)).toBeVisible();

  const evidence = await page.evaluate(async (): Promise<Evidence> => {
    const container = Array.from(document.querySelectorAll<HTMLElement>('div[role="group"]')).find(
      (d) => d.querySelector("canvas"),
    );
    if (container === undefined) throw new Error("no chart container");
    type Series = {
      data(): Array<Record<string, unknown>>;
      priceToCoordinate(p: number): number | null;
      options(): { color?: string };
    };
    type Chart = {
      timeScale(): {
        timeToCoordinate(t: string): number | null;
        setVisibleLogicalRange(r: { from: number; to: number }): void;
      };
    };
    const fiberKey = Object.keys(container).find((k) => k.startsWith("__reactFiber$"));
    if (fiberKey === undefined) throw new Error("no React fiber on the chart container");
    let chart: Chart | undefined;
    let main: Series | undefined;
    let lines: Map<string, Series> | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: React internals
    for (let fiber: any = (container as any)[fiberKey]; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === "object"; hook = hook.next) {
        const ref = hook.memoizedState;
        const current = ref && typeof ref === "object" ? ref.current : undefined;
        if (current instanceof Map) lines = current as Map<string, Series>;
        else if (current && typeof current.timeScale === "function") chart = current as Chart;
        else if (
          current &&
          typeof current.data === "function" &&
          typeof current.priceToCoordinate === "function"
        )
          main = current as Series;
      }
    }
    if (chart === undefined || main === undefined || lines === undefined)
      throw new Error("chart refs not found in the fiber");

    const mainData = main.data();
    const candles = mainData.filter((d) => "open" in d || "value" in d);
    const lastCandle = String(candles[candles.length - 1]?.time);

    // the last ~12 months plus the whole extension, so the end of every line is on screen
    const total = candles.length;
    chart.timeScale().setVisibleLogicalRange({ from: total - 260, to: total + 126 + 40 });
    // wait (bounded) until the end of the extension is laid out inside the plot, instead of a fixed sleep
    const probe = lines.values().next().value as Series;
    const probeData = probe.data();
    const probeTime = String(probeData[probeData.length - 1]?.time);
    for (let i = 0; i < 100; i++) {
      const px = chart.timeScale().timeToCoordinate(probeTime);
      if (px !== null && px > 0 && px < container.clientWidth - 70) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const weekdaysBetween = (from: string, to: string): number => {
      const d = new Date(`${from}T00:00:00Z`);
      let n = 0;
      while (d.toISOString().slice(0, 10) < to) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
      }
      return n;
    };
    const canvases = Array.from(container.querySelectorAll("canvas"));
    const dpr = window.devicePixelRatio || 1;
    const parse = (css: string): [number, number, number] => {
      const probe = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const px = probe.getImageData(0, 0, 1, 1).data;
      return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
    };
    const painted = (
      color: [number, number, number],
      x0: number,
      x1: number,
      y: number,
    ): number => {
      let count = 0;
      let sampledCanvases = 0;
      for (const canvas of canvases) {
        const ctx = canvas.getContext("2d");
        if (ctx === null || canvas.width < 50) continue;
        const left = Math.max(0, Math.floor(Math.min(x0, x1) * dpr));
        const width = Math.min(canvas.width - left, Math.ceil(Math.abs(x1 - x0) * dpr));
        const top = Math.max(0, Math.floor(y * dpr) - 3);
        const height = Math.min(canvas.height - top, 7);
        if (width <= 0 || height <= 0) continue;
        sampledCanvases++;
        const data = ctx.getImageData(left, top, width, height).data;
        const dist = (r: number, g: number, b: number, c: readonly number[]) =>
          Math.abs(r - (c[0] ?? 0)) + Math.abs(g - (c[1] ?? 0)) + Math.abs(b - (c[2] ?? 0));
        // the background is the most frequent colour of the region; a painted pixel is clearly nearer the line colour than the background
        const freq = new Map<number, number>();
        for (let i = 0; i < data.length; i += 4) {
          const k = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
          freq.set(k, (freq.get(k) ?? 0) + 1);
        }
        const top1 = [...freq.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
        const bg = [(top1 >> 16) & 255, (top1 >> 8) & 255, top1 & 255];
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i + 3] ?? 0) < 200) continue;
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const bl = data[i + 2] ?? 0;
          if (dist(r, g, bl, color) < 0.6 * dist(r, g, bl, bg)) count++;
        }
      }
      if (sampledCanvases === 0)
        throw new Error(`sample band (${x0}..${x1}, y ${y}) is outside every canvas`);
      return count;
    };

    const out: LineEvidence[] = [];
    for (const [key, series] of lines) {
      const points = series.data();
      const last = points[points.length - 1] as { time: string; value: number };
      const x = chart.timeScale().timeToCoordinate(last.time);
      const y = series.priceToCoordinate(last.value);
      if (x === null || y === null)
        throw new Error(`line ${key}: end point off screen (${x}, ${y})`);
      const color = parse(series.options().color ?? "#000");
      out.push({
        key,
        points: points.length,
        lastTime: last.time,
        lastValue: last.value,
        color: series.options().color ?? "",
        extensionBars: weekdaysBetween(lastCandle, last.time),
        xEnd: x,
        paintedBeforeEnd: painted(color, x - 120, x - 2, y),
        paintedAfterEnd: painted(color, x + 4, x + 24, y),
      });
    }
    const logoEl = container.querySelector<HTMLAnchorElement>("a#tv-attr-logo");
    const rect = logoEl?.getBoundingClientRect();
    return {
      lastCandle,
      lines: out,
      logo:
        logoEl === null
          ? null
          : {
              href: logoEl.getAttribute("href"),
              visible: (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0,
              hasSvg: logoEl.querySelector("svg") !== null,
            },
    };
  });

  console.log(`chart spike evidence: ${JSON.stringify(evidence)}`);
  expect(evidence.lines.map((l) => l.key).sort()).toEqual([
    "base",
    "lower1",
    "lower2",
    "upper1",
    "upper2",
  ]);
  for (const line of evidence.lines) {
    expect(line.points, `${line.key} points`).toBe(3);
    expect(line.extensionBars, `${line.key}: bars past the last candle`).toBe(126);
    expect(line.paintedBeforeEnd, `${line.key}: pixels just before the line end`).toBeGreaterThan(
      2,
    );
    expect(line.paintedAfterEnd, `${line.key}: pixels just after the line end`).toBe(0);
  }
  expect(evidence.logo, "the TradingView attribution logo").not.toBeNull();
  expect(evidence.logo?.visible).toBe(true);
  expect(evidence.logo?.hasSvg).toBe(true);
  expect(evidence.logo?.href ?? "").toMatch(/^https:\/\/www\.tradingview\.com\//);
});
