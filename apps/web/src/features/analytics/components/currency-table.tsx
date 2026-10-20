import { MoneyText } from "../../portfolio/money-text";
import type { PerCurrencyRow } from "../analytics-model";

const HEADERS = [
  "Currency",
  "Realized P&L",
  "Dividends gross",
  "Withholding",
  "Dividends net",
  "Commissions",
  "Other costs",
  "Cost basis",
  "Market value",
  "Unrealized P&L",
];

export function CurrencyTable({ rows }: { rows: readonly PerCurrencyRow[] }) {
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No currency has any activity yet.</p>;
  return (
    <section
      aria-label="Per-currency breakdown, scrolls sideways"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll this region
      tabIndex={0}
      className="overflow-x-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <table aria-label="Per-currency breakdown" className="w-full text-sm tabular-nums">
        <caption className="mb-1 text-left text-xs text-muted-foreground">
          Native currencies, not converted: each row is in its own unit.
        </caption>
        <thead>
          <tr>
            {HEADERS.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`whitespace-nowrap px-2 py-1 font-medium ${i === 0 ? "text-left" : "text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ccy} className="border-t">
              <th scope="row" className="px-2 py-1 text-left font-medium">
                {r.ccy}
              </th>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.realized} signed />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.dividendsGross} />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.dividendsWithholding} signed />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.dividendsNet} signed />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.commissions} />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.otherCosts} />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.cost} />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.value} />
              </td>
              <td className="px-2 py-1 text-right">
                <MoneyText money={r.unrealized} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
