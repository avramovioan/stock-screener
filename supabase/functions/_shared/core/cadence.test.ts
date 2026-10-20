import { describe, expect, it } from "vitest";
import {
  aiGate,
  isSofiaWeekend,
  nextAiWindowStart,
  scheduleHorizon,
  sofiaWallToUtc,
} from "./cadence.ts";

const t = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

describe("isSofiaWeekend", () => {
  it("is false until Sofia midnight on Friday and true from Saturday 00:00 (summer time)", () => {
    expect(isSofiaWeekend(t("2026-10-16T20:59:59Z"))).toBe(false); // Fri 23:59:59 EEST
    expect(isSofiaWeekend(t("2026-10-16T21:00:00Z"))).toBe(true); // Sat 00:00 EEST
  });
  it("uses the winter offset after the October change", () => {
    expect(isSofiaWeekend(t("2026-11-06T21:59:59Z"))).toBe(false); // Fri 23:59:59 EET
    expect(isSofiaWeekend(t("2026-11-06T22:00:00Z"))).toBe(true); // Sat 00:00 EET
  });
  it("is false again on Monday 00:00 Sofia", () => {
    expect(isSofiaWeekend(t("2026-10-18T20:59:59Z"))).toBe(true); // Sun 23:59:59 EEST
    expect(isSofiaWeekend(t("2026-10-18T21:00:00Z"))).toBe(false); // Mon 00:00 EEST
  });
});

describe("sofiaWallToUtc", () => {
  it("maps 10:00 Sofia to 07:00Z in summer and 08:00Z in winter", () => {
    expect(iso(sofiaWallToUtc(2026, 7, 15, 10, 0))).toBe("2026-07-15T07:00:00.000Z");
    expect(iso(sofiaWallToUtc(2026, 1, 15, 10, 0))).toBe("2026-01-15T08:00:00.000Z");
  });
  it("handles the two change days (2026-03-29 and 2026-10-25)", () => {
    expect(iso(sofiaWallToUtc(2026, 3, 29, 10, 0))).toBe("2026-03-29T07:00:00.000Z");
    expect(iso(sofiaWallToUtc(2026, 3, 28, 10, 0))).toBe("2026-03-28T08:00:00.000Z");
    expect(iso(sofiaWallToUtc(2026, 10, 25, 10, 0))).toBe("2026-10-25T08:00:00.000Z");
    expect(iso(sofiaWallToUtc(2026, 10, 24, 10, 0))).toBe("2026-10-24T07:00:00.000Z");
  });
});

describe("nextAiWindowStart", () => {
  it("returns the instant itself on a weekday", () => {
    expect(nextAiWindowStart(t("2026-10-15T08:00:00Z"), true)).toBe(t("2026-10-15T08:00:00Z"));
  });
  it("moves Saturday and Sunday to Monday 10:00 Sofia", () => {
    expect(iso(nextAiWindowStart(t("2026-10-17T08:00:00Z"), true))).toBe(
      "2026-10-19T07:00:00.000Z",
    );
    expect(iso(nextAiWindowStart(t("2026-10-18T20:00:00Z"), true))).toBe(
      "2026-10-19T07:00:00.000Z",
    );
  });
  it("crosses the October DST change: Saturday 2026-10-24 -> Monday 10:00 EET", () => {
    expect(iso(nextAiWindowStart(t("2026-10-24T09:00:00Z"), true))).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });
  it("crosses the March DST change: Saturday 2026-03-28 -> Monday 10:00 EEST", () => {
    expect(iso(nextAiWindowStart(t("2026-03-28T09:00:00Z"), true))).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });
  it("is the identity when weekends are allowed", () => {
    expect(nextAiWindowStart(t("2026-10-17T08:00:00Z"), false)).toBe(t("2026-10-17T08:00:00Z"));
  });
});

describe("aiGate", () => {
  const base = { weekdaysOnly: true, minRecheckHours: 72, applyCadence: true };
  it("allows a weekday with no recent activity", () => {
    expect(aiGate({ ...base, nowMs: t("2026-10-15T08:00:00Z"), lastActivityMs: null })).toEqual({
      allowed: true,
    });
  });
  it("waits for the weekend with reason weekend", () => {
    const g = aiGate({ ...base, nowMs: t("2026-10-17T08:00:00Z"), lastActivityMs: null });
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toBe("weekend");
      expect(iso(g.notBeforeMs)).toBe("2026-10-19T07:00:00.000Z");
      expect(g.lastActivityMs).toBeNull();
    }
  });
  it("waits 72 hours after the last activity with reason cadence_72h", () => {
    const last = t("2026-10-13T08:00:00Z"); // Tue
    const g = aiGate({ ...base, nowMs: t("2026-10-14T08:00:00Z"), lastActivityMs: last });
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toBe("cadence_72h");
      expect(iso(g.notBeforeMs)).toBe("2026-10-16T08:00:00.000Z"); // Fri 11:00 Sofia
      expect(g.lastActivityMs).toBe(last);
    }
  });
  it("allows exactly at the 72 hour mark", () => {
    const last = t("2026-10-13T08:00:00Z");
    expect(aiGate({ ...base, nowMs: last + 72 * 3_600_000, lastActivityMs: last })).toEqual({
      allowed: true,
    });
  });
  it("pushes a 72 hour due time that lands on a weekend to Monday 10:00", () => {
    const g = aiGate({
      ...base,
      nowMs: t("2026-10-15T08:00:00Z"),
      lastActivityMs: t("2026-10-14T08:00:00Z"), // due Sat 2026-10-17 11:00 Sofia
    });
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toBe("cadence_72h");
      expect(iso(g.notBeforeMs)).toBe("2026-10-19T07:00:00.000Z");
    }
  });
  it("ignores the last activity when the cadence does not apply", () => {
    expect(
      aiGate({
        ...base,
        applyCadence: false,
        nowMs: t("2026-10-14T08:00:00Z"),
        lastActivityMs: t("2026-10-14T07:00:00Z"),
      }),
    ).toEqual({ allowed: true });
  });
  it("lets weekends through when weekdaysOnly is false, but keeps the cadence", () => {
    const sat = t("2026-10-17T08:00:00Z");
    expect(aiGate({ ...base, weekdaysOnly: false, nowMs: sat, lastActivityMs: null })).toEqual({
      allowed: true,
    });
    const g = aiGate({ ...base, weekdaysOnly: false, nowMs: sat, lastActivityMs: sat - 3_600_000 });
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(iso(g.notBeforeMs)).toBe("2026-10-20T07:00:00.000Z");
  });
  it("reports cadence_72h when both bind, with the later of the two times", () => {
    const g = aiGate({
      ...base,
      nowMs: t("2026-10-17T08:00:00Z"), // Saturday
      lastActivityMs: t("2026-10-16T08:00:00Z"), // due Monday 2026-10-19 11:00 Sofia (08:00Z)
    });
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toBe("cadence_72h");
      expect(iso(g.notBeforeMs)).toBe("2026-10-19T08:00:00.000Z");
    }
  });
});

describe("scheduleHorizon", () => {
  it("is now on Monday to Thursday", () => {
    const now = t("2026-10-15T07:00:00Z"); // Thu
    expect(scheduleHorizon(now, true)).toBe(now);
  });
  it("reaches Monday 10:00 Sofia from Friday and Saturday", () => {
    expect(iso(scheduleHorizon(t("2026-10-16T07:00:00Z"), true))).toBe("2026-10-19T07:00:00.000Z");
    expect(iso(scheduleHorizon(t("2026-10-17T07:00:00Z"), true))).toBe("2026-10-19T07:00:00.000Z");
  });
  it("is now when weekends are allowed", () => {
    const now = t("2026-10-17T07:00:00Z");
    expect(scheduleHorizon(now, false)).toBe(now);
  });
});
