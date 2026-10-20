export const SOFIA = "Europe/Sofia";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number;
}

/** Freshness classification limit (assumption A-10): `fresh` up to the exchange's max gap, `stale` up to 10 days, then `unavailable`. */
export const STALE_LIMIT_DAYS = 10;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (days-from-civil algorithm). */
export function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12; // March = 0 ... February = 11
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(n: number): { year: number; month: number; day: number } {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** ISO weekday (Monday = 1 ... Sunday = 7) of a day number. 1970-01-01 was a Thursday (4). */
export function isoWeekdayOf(dayN: number): number {
  return ((((dayN + 3) % 7) + 7) % 7) + 1;
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (p === undefined) throw new Error(`Intl returned no ${type} part for ${tz}`);
    return Number(p.value);
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    year,
    month,
    day,
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    isoWeekday: isoWeekdayOf(dayNumber(year, month, day)),
  };
}

export function isoDate(n: number): string {
  const { year, month, day } = fromDayNumber(n);
  const pad = (v: number, w: number) => String(v).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Exchange-local calendar day of an instant, as a day number. Never use the UTC date of a bar timestamp. */
export function localDayNumber(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return dayNumber(p.year, p.month, p.day);
}

/** Europe/Sofia date of the instant, "YYYY-MM-DD". */
export function scanDateLocal(epochMs: number): string {
  return isoDate(localDayNumber(epochMs, SOFIA));
}

/** True when the Sofia hour is 10: the only mapping from UTC cron firings to 10:00 local (no DST table). */
export function isScanStartHour(epochMs: number): boolean {
  return localParts(epochMs, SOFIA).hour === 10;
}

/** Feb 29 minus N years lands on Feb 28 when the target year is not a leap year. */
export function subtractYears(dayN: number, years: number): number {
  const { year, month, day } = fromDayNumber(dayN);
  const target = year - years;
  const leap = (target % 4 === 0 && target % 100 !== 0) || target % 400 === 0;
  const d = month === 2 && day === 29 && !leap ? 28 : day;
  return dayNumber(target, month, d);
}

export function isFresh(lastSessionDay: number, scanDay: number, maxGapDays: number): boolean {
  return scanDay - lastSessionDay <= maxGapDays;
}

export type FreshnessClass = "fresh" | "stale" | "unavailable";

/** fresh: gap <= maxGapDays (5); stale: up to 10 days; unavailable: beyond that or when no bar exists (A-10). */
export function freshnessOf(
  lastSessionDay: number | null,
  scanDay: number,
  maxGapDays: number,
): FreshnessClass {
  if (lastSessionDay === null) return "unavailable";
  const gap = scanDay - lastSessionDay;
  if (gap <= maxGapDays) return "fresh";
  if (gap <= STALE_LIMIT_DAYS) return "stale";
  return "unavailable";
}

/** Count of days in [fromDay, toDay] (inclusive) whose ISO weekday is in tradingDays. Statistics only; never rejects a session. */
export function expectedWeekdays(
  fromDay: number,
  toDay: number,
  tradingDays: readonly number[],
): number {
  const set = new Set(tradingDays);
  let count = 0;
  for (let n = fromDay; n <= toDay; n++) {
    if (set.has(isoWeekdayOf(n))) count++;
  }
  return count;
}
