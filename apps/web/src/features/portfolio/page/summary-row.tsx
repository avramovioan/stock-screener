import type { CurrencyBreakdown, PortfolioTotals } from "@core/portfolio-view.ts";
import type { ReactNode } from "react";
import { Popover } from "@/components/popover";
import { formatAmount, MoneyText } from "../money-text";
import { InfoBox } from "./info-box";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function notes(totals: PortfolioTotals, base: string) {
  return (
    <div className="space-y-1.5">
      <p>{`Converted to ${base} at current rates (Yahoo delayed FX; the statement rate where a position says so), so value minus cost equals the unrealized P&L.`}</p>
      {totals.excluded.length > 0 ? (
        <p>{`${totals.excluded.length} position${totals.excluded.length === 1 ? " is" : "s are"} excluded from the totals: ${totals.excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}.`}</p>
      ) : null}
      {totals.dailyExcluded > 0 ? (
        <p>{`Daily P&L leaves out ${totals.dailyExcluded} position${totals.dailyExcluded === 1 ? "" : "s"} without a delayed quote.`}</p>
      ) : null}
    </div>
  );
}

function Breakdown({ perCurrency }: { perCurrency: readonly CurrencyBreakdown[] }) {
  return (
    <Popover
      trigger={<span className="underline">Per-currency breakdown</span>}
      triggerLabel="Per-currency breakdown"
      panelLabel="Per-currency breakdown"
      panelClassName="w-96 max-w-[calc(100vw-2rem)]"
    >
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left">
            <th scope="col">Currency</th>
            <th scope="col">Cost basis</th>
            <th scope="col">Market value</th>
            <th scope="col">Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {perCurrency.map((c) => (
            <tr key={c.ccy}>
              <th scope="row" className="text-left font-normal">
                {c.ccy}
              </th>
              <td>
                <MoneyText money={c.cost} />
              </td>
              <td>
                <MoneyText money={c.value} />
              </td>
              <td>
                <MoneyText money={c.unrealized} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Each currency is shown in its own unit. Positions without a price or cost basis are left out
        of their row.
      </p>
    </Popover>
  );
}

/** Summary above the list (all breakpoints; on phones it replaces the table's summary row, spec 14.9). */
export function SummaryCard({
  totals,
  perCurrency,
  base,
}: {
  totals: PortfolioTotals;
  perCurrency: readonly CurrencyBreakdown[];
  base: string;
}) {
  return (
    <section aria-label="Portfolio summary" className="space-y-2 rounded-md border p-3">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total cost basis">
          <MoneyText money={totals.costBase} />
        </Stat>
        <Stat label="Market value">
          <MoneyText money={totals.valueBase} />
        </Stat>
        <Stat label="Daily P&L (estimated)">
          <MoneyText money={totals.dailyBase} signed />
        </Stat>
        <Stat label="Unrealized P&L">
          <MoneyText money={totals.unrealizedBase} signed />
        </Stat>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Breakdown perCurrency={perCurrency} />
        <InfoBox label="How these are computed" className="w-96">
          {notes(totals, base)}
        </InfoBox>
      </div>
    </section>
  );
}

/** The totals as the final row of the desktop table: value, then unrealized P&L with today's change beneath. */
export function SummaryTableRow({ totals, base }: { totals: PortfolioTotals; base: string }) {
  const daily = totals.dailyBase;
  return (
    <tr className="border-t-2 font-medium">
      <th scope="row" colSpan={3} className="px-3 py-3 text-left">{`Total in ${base}`}</th>
      <td className="whitespace-nowrap px-3 py-3 text-right">
        <MoneyText money={totals.valueBase} />
      </td>
      <td className="px-3 py-3 text-right">
        <div className="flex flex-col items-end gap-0.5">
          <MoneyText money={totals.unrealizedBase} signed />
          {daily.kind === "ok" ? (
            <span className="whitespace-nowrap text-xs">
              {`${daily.value > 0 ? "+" : ""}${formatAmount(daily.value)} ${daily.ccy} today`}
            </span>
          ) : (
            <MoneyText money={daily} className="text-xs" />
          )}
        </div>
      </td>
      <td className="px-3 py-3" />
      <td className="px-3 py-3" />
    </tr>
  );
}
