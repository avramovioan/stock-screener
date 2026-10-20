import { dayNumber, fromDayNumber, localParts, SOFIA } from "./calendar.ts";

/**
 * Research cadence (owner decisions 2026-10-16): no AI work on Saturday or Sunday (Europe/Sofia), and none for a security
 * within `min_recheck_hours` of its last AI activity. Pure functions of the instant; the wiring lives in worker-tick.
 */

const HOUR_MS = 3_600_000;
/** Work that waits for the weekend to end starts Monday 10:00 Sofia, the same minute the daily scan starts. */
export const WINDOW_START_HOUR = 10;

export type GateReason = "weekend" | "cadence_72h";

export type AiGate =
  | { allowed: true }
  | {
      allowed: false;
      reason: GateReason;
      /** Earliest instant the work may run (epoch ms). */
      notBeforeMs: number;
      /** The last AI activity the cadence counted from, null when there was none (epoch ms). */
      lastActivityMs: number | null;
    };

export function isSofiaWeekend(epochMs: number): boolean {
  return localParts(epochMs, SOFIA).isoWeekday >= 6;
}

/** Epoch ms of a Europe/Sofia wall-clock time (never called with a time inside the spring-forward gap). */
export function sofiaWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - 3 * HOUR_MS; // start from summer time, then correct by what Intl says the guess reads in Sofia
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, SOFIA);
    guess += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return guess;
}

/** The instant itself, or Monday 10:00 Sofia when it falls on a Sofia weekend and `weekdaysOnly` is set. */
export function nextAiWindowStart(epochMs: number, weekdaysOnly: boolean): number {
  if (!weekdaysOnly || !isSofiaWeekend(epochMs)) return epochMs;
  const p = localParts(epochMs, SOFIA);
  const today = dayNumber(p.year, p.month, p.day);
  const monday = today + (p.isoWeekday === 6 ? 2 : 1);
  const d = fromDayNumber(monday);
  return sofiaWallToUtc(d.year, d.month, d.day, WINDOW_START_HOUR, 0);
}

export function aiGate(i: {
  nowMs: number;
  weekdaysOnly: boolean;
  minRecheckHours: number;
  /** Last AI activity of the security; ignored when `applyCadence` is false. */
  lastActivityMs: number | null;
  applyCadence: boolean;
}): AiGate {
  const last = i.applyCadence ? i.lastActivityMs : null;
  const due = last === null ? i.nowMs : last + i.minRecheckHours * HOUR_MS;
  const start = nextAiWindowStart(Math.max(i.nowMs, due), i.weekdaysOnly);
  if (start <= i.nowMs) return { allowed: true };
  return {
    allowed: false,
    reason: due > i.nowMs ? "cadence_72h" : "weekend",
    notBeforeMs: start,
    lastActivityMs: last,
  };
}

/**
 * Seeding horizon: a scan on Friday or Saturday also queues the work that falls due over the weekend (with a not_before of
 * Monday 10:00), because no scan runs on Sunday and Monday morning. Other days: just now.
 */
export function scheduleHorizon(nowMs: number, weekdaysOnly: boolean): number {
  if (!weekdaysOnly) return nowMs;
  const weekday = localParts(nowMs, SOFIA).isoWeekday;
  if (weekday < 5 || weekday > 6) return nowMs;
  const p = localParts(nowMs, SOFIA);
  const monday = dayNumber(p.year, p.month, p.day) + (weekday === 5 ? 3 : 2);
  const d = fromDayNumber(monday);
  return sofiaWallToUtc(d.year, d.month, d.day, WINDOW_START_HOUR, 0);
}
