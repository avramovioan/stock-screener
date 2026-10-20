const SOFIA = "Europe/Sofia";
/** The daily scan starts at 10:00 Sofia time; the digest follows when it finishes, usually within the hour. */
const START_HOUR = 10;

export interface DeliveryWindow {
  start: string;
  end: string;
}

function parts(instant: number, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone);
  return (
    Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour, p.minute, p.second) - instant
  );
}

/** The instant at which the wall clock in Sofia shows `hour:00` on the given Sofia date. */
function sofiaInstant(year: number, month: number, day: number, hour: number): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  const guess = wall - offsetAt(wall, SOFIA);
  // Re-read the offset at the guess so a day with a clock change still lands on the right instant.
  return wall - offsetAt(guess, SOFIA);
}

/**
 * The 10:00 to 11:00 Sofia window of Sofia's current day, shown in the viewer's time zone.
 * `timeZone` and `locale` exist for tests; the app leaves them to the browser.
 */
export function deliveryWindow(
  now: Date,
  options: { timeZone?: string; locale?: string } = {},
): DeliveryWindow {
  const today = parts(now.getTime(), SOFIA);
  const start = sofiaInstant(today.year ?? 0, today.month ?? 1, today.day ?? 1, START_HOUR);
  const end = sofiaInstant(today.year ?? 0, today.month ?? 1, today.day ?? 1, START_HOUR + 1);
  const format = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return { start: format.format(start), end: format.format(end) };
}
