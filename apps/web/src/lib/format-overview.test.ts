import { describe, expect, it } from "vitest";
import { formatMonthDay, formatSofiaClock, formatSofiaDayClock, formatSofiaShort } from "./format";

describe("Overview date formats (Europe/Sofia)", () => {
  it("formatSofiaShort is Mon D, HH:mm", () => {
    expect(formatSofiaShort("2026-10-16T10:06:00Z")).toBe("Oct 16, 13:06");
    expect(formatSofiaShort("2026-01-05T21:30:00Z")).toBe("Jan 5, 23:30");
    expect(formatSofiaShort("2026-10-15T21:30:00Z")).toBe("Oct 16, 00:30");
  });
  it("formatSofiaClock is HH:mm on a 24 hour clock", () => {
    expect(formatSofiaClock("2026-10-15T11:10:00Z")).toBe("14:10");
    expect(formatSofiaClock("2026-10-15T21:05:00Z")).toBe("00:05");
  });
  it("formatSofiaDayClock is the short weekday and HH:mm", () => {
    expect(formatSofiaDayClock("2026-10-19T07:00:00Z")).toBe("Mon 10:00");
    expect(formatSofiaDayClock("2026-10-16T07:00:00Z")).toBe("Fri 10:00");
  });
  it("formatMonthDay shows a session date without a zone shift", () => {
    expect(formatMonthDay("2026-10-15")).toBe("Oct 15");
    expect(formatMonthDay("2026-01-01")).toBe("Jan 1");
  });
  it("a missing or invalid value is n/a", () => {
    for (const fn of [formatSofiaShort, formatSofiaClock, formatSofiaDayClock]) {
      expect(fn(null)).toBe("n/a");
      expect(fn("nope")).toBe("n/a");
    }
    expect(formatMonthDay(null)).toBe("n/a");
    expect(formatMonthDay("2026-02-30")).toBe("n/a");
  });
});
