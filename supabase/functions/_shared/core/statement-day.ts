// When a Flex statement is expected, how stale it is, and the disclosure text (spec 12.6, 12.8). Pure.
import { dayNumber, isoDate, isoWeekdayOf, localParts, SOFIA } from "./calendar.ts";

export const AUTO_REFRESH_MS = 5 * 60_000;
export const MANUAL_COOLDOWN_S = 60;
/** The daily Flex sync starts at 08:00 Europe/Sofia (A-33): before that hour the previous day's statement is not expected yet. */
export const STATEMENT_HOUR_LOCAL = 8;

/** The previous weekday (Sofia calendar) counted from 08:00 local; weekends are skipped, exchange holidays are not modelled. */
export function expectedStatementDate(nowMs: number): string {
  const p = localParts(nowMs, SOFIA);
  let reference = dayNumber(p.year, p.month, p.day);
  if (p.hour < STATEMENT_HOUR_LOCAL) reference -= 1;
  let day = reference - 1;
  while (isoWeekdayOf(day) >= 6) day -= 1;
  return isoDate(day);
}

export type StatementFreshness =
  | { kind: "current" }
  | { kind: "behind"; days: number }
  | { kind: "unknown" };

export function statementFreshness(
  reportDate: string | null,
  expected: string,
): StatementFreshness {
  if (reportDate === null) return { kind: "unknown" };
  if (reportDate >= expected) return { kind: "current" };
  const num = (iso: string): number =>
    dayNumber(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
  return { kind: "behind", days: num(expected) - num(reportDate) };
}

export function dailySyncDue(i: {
  lastStatementDate: string | null;
  expected: string;
  nextFetchNotBeforeMs: number | null;
  nowMs: number;
  hasActiveRun: boolean;
}): boolean {
  if (i.hasActiveRun) return false;
  if (i.lastStatementDate !== null && i.lastStatementDate >= i.expected) return false;
  return i.nextFetchNotBeforeMs === null || i.nextFetchNotBeforeMs <= i.nowMs;
}

export function t1Disclosure(reportDate: string | null): string {
  return `Positions, trades and cost basis come from your IBKR Activity Flex statement as of ${reportDate ?? "an unknown date"} (end of day). Trades made today appear after IBKR builds tomorrow's statement. Prices shown are delayed Yahoo quotes.`;
}
