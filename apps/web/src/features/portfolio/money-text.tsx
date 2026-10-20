import type { Money } from "@core/accounting.ts";

const two = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const small = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatAmount(value: number): string {
  return value !== 0 && Math.abs(value) < 1 ? small.format(value) : two.format(value);
}

/** "2,320.00 USD"; an unavailable amount renders a dash plus a visually hidden reason (never 0). */
export function MoneyText({
  money,
  signed = false,
  className = "",
}: {
  money: Money;
  signed?: boolean;
  className?: string;
}) {
  if (money.kind === "unavailable") {
    return (
      <span className={`whitespace-nowrap ${className}`} title={money.reason}>
        <span aria-hidden="true">{"—"}</span>
        <span className="sr-only">{`Unavailable: ${money.reason}`}</span>
      </span>
    );
  }
  // the sign is part of the text (never colour alone); the currency code is spelled out so mixed currencies are never ambiguous
  const sign = signed && money.value > 0 ? "+" : "";
  return (
    <span
      className={`whitespace-nowrap tabular-nums ${className}`}
    >{`${sign}${formatAmount(money.value)} ${money.ccy}`}</span>
  );
}
