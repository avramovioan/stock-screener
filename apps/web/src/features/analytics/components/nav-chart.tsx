import { createChart, LineSeries } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatAmount } from "../../portfolio/money-text";

export interface NavPointView {
  date: string;
  value: number;
}

/** One line (NAV in the base currency per statement day). The chart is decoration for sighted users; the table below is the data. */
export function NavChart({
  points,
  currency,
}: {
  points: readonly NavPointView[];
  currency: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (points.length < 2 || ref.current === null) return;
    const dark = document.documentElement.classList.contains("dark");
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 260,
      layout: { background: { color: "transparent" }, textColor: dark ? "#d4d4d8" : "#3f3f46" },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? "#27272a" : "#e4e4e7" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const line = chart.addSeries(LineSeries, {
      color: dark ? "#7aa2ff" : "#1d4ed8",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    line.setData(points.map((p) => ({ time: p.date, value: p.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough NAV history yet: a line needs at least two statement days.
      </p>
    );
  }
  return (
    <figure
      className="space-y-2"
      aria-label={`Net asset value in ${currency} by statement day, from ${points[0]?.date} to ${points.at(-1)?.date}`}
    >
      <div ref={ref} className="h-[260px] w-full" />
      <figcaption className="text-xs text-muted-foreground">{`Net asset value in ${currency}, one point per statement day (broker-reported).`}</figcaption>
      <table aria-label="NAV history (data)" className="sr-only">
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{p.date}</th>
              <td>{`${formatAmount(p.value)} ${currency}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
