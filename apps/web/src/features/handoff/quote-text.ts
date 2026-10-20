import type { QuoteDto } from "@/features/screening/quotes-api";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const two = (n: number): string => String(n).padStart(2, "0");

/** "15 Oct 2026, 08:27 UTC": the modal states times in UTC (spec 13.1), independent of the browser's time zone. */
export function formatUtcStamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export interface EurQuote {
  price: number;
  stamp: string;
  stale: boolean;
}

/** Only a finite positive EUR price with a timestamp is usable. A quote in any other currency is never shown or used as a prefill. */
export function usableEurQuote(q: QuoteDto | undefined): EurQuote | null {
  if (q === undefined || q.currency !== "EUR") return null;
  const price = q.regularMarketPrice;
  const time = q.regularMarketTime;
  if (
    price === null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    time === null ||
    !Number.isFinite(time)
  )
    return null;
  return { price, stamp: formatUtcStamp(time), stale: q.stale };
}

/** The limit price prefill: the delayed quote rounded to 2 decimals. */
export function prefillPrice(price: number): string {
  return price.toFixed(2);
}
