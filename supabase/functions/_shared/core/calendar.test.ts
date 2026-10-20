import { describe, expect, it } from "vitest";
import {
  dayNumber,
  expectedWeekdays,
  freshnessOf,
  fromDayNumber,
  isFresh,
  isoDate,
  isoWeekdayOf,
  isScanStartHour,
  localDayNumber,
  localParts,
  SOFIA,
  scanDateLocal,
  subtractYears,
} from "./calendar.ts";

const utc = (iso: string) => Date.parse(iso);

describe("dayNumber / fromDayNumber", () => {
  it("anchors 1970-01-01 at 0", () => {
    expect(dayNumber(1970, 1, 1)).toBe(0);
    expect(dayNumber(1970, 1, 2)).toBe(1);
    expect(dayNumber(1969, 12, 31)).toBe(-1);
  });
  it("matches Date.UTC for sample dates over a century", () => {
    for (let y = 1990; y <= 2090; y += 3) {
      for (const [m, d] of [
        [1, 1],
        [2, 28],
        [3, 1],
        [7, 15],
        [12, 31],
      ] as const) {
        expect(dayNumber(y, m, d)).toBe(Math.floor(Date.UTC(y, m - 1, d) / 86_400_000));
      }
    }
  });
  it("round-trips every day over 1900..2100", () => {
    const from = dayNumber(1900, 1, 1);
    const to = dayNumber(2100, 12, 31);
    for (let n = from; n <= to; n++) {
      const { year, month, day } = fromDayNumber(n);
      expect(dayNumber(year, month, day)).toBe(n);
    }
  });
  it("handles leap days (2000 is leap; 1900 and 2100 are not)", () => {
    expect(fromDayNumber(dayNumber(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });
    expect(dayNumber(1900, 3, 1) - dayNumber(1900, 2, 28)).toBe(1);
    expect(dayNumber(2100, 3, 1) - dayNumber(2100, 2, 28)).toBe(1);
  });
  it("formats ISO dates with zero padding", () => {
    expect(isoDate(dayNumber(2026, 3, 5))).toBe("2026-03-05");
    expect(isoDate(dayNumber(2026, 10, 25))).toBe("2026-10-25");
  });
  it("derives ISO weekdays", () => {
    expect(isoWeekdayOf(0)).toBe(4); // Thursday
    expect(isoWeekdayOf(dayNumber(2026, 10, 15))).toBe(4);
    expect(isoWeekdayOf(dayNumber(2026, 10, 17))).toBe(6);
    expect(isoWeekdayOf(dayNumber(2026, 10, 18))).toBe(7);
    expect(isoWeekdayOf(-1)).toBe(3);
  });
});

describe("localParts", () => {
  it("returns Sofia wall-clock fields in summer (UTC+3)", () => {
    expect(localParts(utc("2026-07-15T07:00:00Z"), SOFIA)).toEqual({
      year: 2026,
      month: 7,
      day: 15,
      hour: 10,
      minute: 0,
      second: 0,
      isoWeekday: 3,
    });
  });
  it("uses a 24-hour clock at local midnight (no hour 24)", () => {
    const p = localParts(utc("2026-07-14T21:00:00Z"), SOFIA);
    expect(p.hour).toBe(0);
    expect(p.day).toBe(15);
  });
});

describe("Sofia scan start hour (DST guard)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["ordinary summer day 07:00Z (10:00 EEST)", "2026-07-15T07:00:00Z", true],
    ["ordinary summer day 08:00Z (11:00 EEST)", "2026-07-15T08:00:00Z", false],
    ["ordinary winter day 07:00Z (09:00 EET)", "2026-01-15T07:00:00Z", false],
    ["ordinary winter day 08:00Z (10:00 EET)", "2026-01-15T08:00:00Z", true],
    ["spring change 2026-03-29 07:00Z (already EEST)", "2026-03-29T07:00:00Z", true],
    ["spring change 2026-03-29 08:00Z", "2026-03-29T08:00:00Z", false],
    ["autumn change 2026-10-25 07:00Z (already EET)", "2026-10-25T07:00:00Z", false],
    ["autumn change 2026-10-25 08:00Z", "2026-10-25T08:00:00Z", true],
  ];
  it.each(cases)("%s -> %s", (_label, iso, expected) => {
    expect(isScanStartHour(utc(iso))).toBe(expected);
  });

  it("exactly one of the two cron firings passes on every day of 2026", () => {
    for (let n = dayNumber(2026, 1, 1); n <= dayNumber(2026, 12, 31); n++) {
      const base = n * 86_400_000;
      const passes = [7, 8].filter((h) => isScanStartHour(base + h * 3_600_000));
      expect(passes).toHaveLength(1);
    }
  });

  it("derives the Sofia scan date", () => {
    expect(scanDateLocal(utc("2026-03-29T07:00:00Z"))).toBe("2026-03-29");
    expect(scanDateLocal(utc("2026-10-25T08:00:00Z"))).toBe("2026-10-25");
    expect(scanDateLocal(utc("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
  });
});

describe("exchange session days from bar timestamps (never the UTC date)", () => {
  it("AAPL bar 2026-10-14T13:30Z is the 2026-10-14 New York session", () => {
    expect(isoDate(localDayNumber(utc("2026-10-14T13:30:00Z"), "America/New_York"))).toBe(
      "2026-10-14",
    );
  });
  it("0700.HK bar 2026-10-15T01:30Z is the 2026-10-15 Hong Kong session", () => {
    expect(isoDate(localDayNumber(utc("2026-10-15T01:30:00Z"), "Asia/Hong_Kong"))).toBe(
      "2026-10-15",
    );
  });
  it("7203.T bar 2026-10-15T00:00Z is the 2026-10-15 Tokyo session", () => {
    expect(isoDate(localDayNumber(utc("2026-10-15T00:00:00Z"), "Asia/Tokyo"))).toBe("2026-10-15");
  });
  it("ASX open 2026-10-14T23:00Z belongs to the 2026-10-15 session (the UTC date is a day early)", () => {
    expect(isoDate(localDayNumber(utc("2026-10-14T23:00:00Z"), "Australia/Sydney"))).toBe(
      "2026-10-15",
    );
  });
  it("New York bars either side of the March DST change keep their local date", () => {
    expect(isoDate(localDayNumber(utc("2026-03-06T14:30:00Z"), "America/New_York"))).toBe(
      "2026-03-06",
    );
    expect(isoDate(localDayNumber(utc("2026-03-09T13:30:00Z"), "America/New_York"))).toBe(
      "2026-03-09",
    );
  });
});

describe("subtractYears", () => {
  it("moves Feb 29 to Feb 28 in a non-leap target year", () => {
    expect(isoDate(subtractYears(dayNumber(2024, 2, 29), 10))).toBe("2014-02-28");
  });
  it("keeps Feb 29 when the target year is a leap year", () => {
    expect(isoDate(subtractYears(dayNumber(2024, 2, 29), 4))).toBe("2020-02-29");
  });
  it("is exact for ordinary dates", () => {
    expect(isoDate(subtractYears(dayNumber(2026, 10, 14), 10))).toBe("2016-10-14");
  });
});

describe("freshness", () => {
  const scan = dayNumber(2026, 10, 15);
  it("isFresh: a gap equal to the limit is fresh, one more is not", () => {
    expect(isFresh(scan - 5, scan, 5)).toBe(true);
    expect(isFresh(scan - 6, scan, 5)).toBe(false);
  });
  it("freshnessOf: fresh <= 5, stale 6..10, unavailable beyond 10 or without a bar", () => {
    expect(freshnessOf(scan - 5, scan, 5)).toBe("fresh");
    expect(freshnessOf(scan - 6, scan, 5)).toBe("stale");
    expect(freshnessOf(scan - 10, scan, 5)).toBe("stale");
    expect(freshnessOf(scan - 11, scan, 5)).toBe("unavailable");
    expect(freshnessOf(null, scan, 5)).toBe("unavailable");
  });
});

describe("expectedWeekdays", () => {
  const mon = dayNumber(2026, 10, 12);
  it("counts Monday..Friday over one week", () => {
    expect(expectedWeekdays(mon, mon + 6, [1, 2, 3, 4, 5])).toBe(5);
  });
  it("counts Sunday..Thursday for Saudi Arabia", () => {
    expect(expectedWeekdays(mon, mon + 6, [7, 1, 2, 3, 4])).toBe(5);
  });
  it("is inclusive on both ends and zero for an inverted span", () => {
    expect(expectedWeekdays(mon, mon, [1])).toBe(1);
    expect(expectedWeekdays(mon + 1, mon, [1, 2, 3, 4, 5])).toBe(0);
  });
});
