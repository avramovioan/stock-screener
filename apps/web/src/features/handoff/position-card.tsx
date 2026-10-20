import { formatAmount, MoneyText } from "@/features/portfolio/money-text";
import { formatSessionDate } from "@/lib/format";
import type { HeldPosition } from "./types";

const shares = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });

/** The exchange the statement reports, in words: Xetra for IBIS/IBIS2, Amsterdam for AEB, any other code as is. */
export function exchangeText(code: string): string {
  if (code === "IBIS" || code === "IBIS2") return `Xetra (${code})`;
  if (code === "AEB") return `Amsterdam (${code})`;
  return code;
}

function Stat({
  label,
  children,
  large = false,
}: {
  label: string;
  children: React.ReactNode;
  large?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`m-0 whitespace-nowrap font-semibold tabular-nums ${large ? "text-[22px] leading-7" : "text-base"}`}
      >
        {children}
      </dd>
    </div>
  );
}

const TONE = (v: number): string =>
  v > 0 ? "text-emerald-800 dark:text-emerald-400" : v < 0 ? "text-red-700 dark:text-red-400" : "";

/** What the owner holds of the instrument, from the portfolio row and the latest statement: how many shares a Sell can use. */
export function PositionCard({ position: p }: { position: HeldPosition }) {
  const pnlTone = p.unrealized.kind === "ok" ? TONE(p.unrealized.value) : "";
  return (
    <section
      aria-labelledby="position-heading"
      data-testid="position-card"
      className="grid gap-2.5 rounded-lg border border-primary bg-accent/40 px-4 py-3.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          id="position-heading"
          className="text-xs font-semibold uppercase tracking-wide text-foreground"
        >
          Your position
        </h3>
        {p.reportDate === null ? null : (
          <span className="text-xs text-muted-foreground">
            {`IBKR statement of ${formatSessionDate(p.reportDate)}`}
          </span>
        )}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
        <Stat label="Shares" large>
          {shares.format(p.quantity)}
        </Stat>
        <Stat label="Avg cost">
          {p.averageCost === null ? "unavailable" : `${formatAmount(p.averageCost)} ${p.currency}`}
        </Stat>
        <Stat label="Value">
          <MoneyText money={p.marketValue} />
        </Stat>
        <Stat label="P&L">
          <MoneyText money={p.unrealized} signed className={pnlTone} />
        </Stat>
      </dl>
      <p className="m-0 text-[13px] text-foreground/80">
        {`Held as ${p.heldSymbol}${p.heldExchange === null ? "" : ` on ${exchangeText(p.heldExchange)}`}, ${p.currency}. Trades from today show up after tomorrow's statement.`}
      </p>
    </section>
  );
}
