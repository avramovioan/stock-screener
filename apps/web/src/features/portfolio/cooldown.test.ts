import { describe, expect, it } from "vitest";
import { formatCountdown, msUntil, serverOffsetMs } from "./cooldown";

describe("countdowns derive from server time, not from the local clock alone", () => {
  it("the offset is server time minus the local time at receipt", () => {
    expect(serverOffsetMs("2026-10-15T07:00:00.000Z", Date.parse("2026-10-15T07:00:05.000Z"))).toBe(
      -5000,
    );
  });

  it("msUntil compares the target with the local clock corrected by the offset and never goes below zero", () => {
    const target = "2026-10-15T07:01:00.000Z";
    const local = Date.parse("2026-10-15T07:00:05.000Z");
    expect(msUntil(target, local, -5000)).toBe(60_000);
    expect(msUntil(target, local + 30_000, -5000)).toBe(30_000);
    expect(msUntil(target, local + 120_000, -5000)).toBe(0);
    expect(msUntil(null, local, 0)).toBe(0);
  });

  it("a skewed local clock still shows the server's countdown", () => {
    const serverNow = Date.parse("2026-10-15T07:00:00.000Z");
    const localSkewed = serverNow + 3_600_000;
    const offset = serverOffsetMs("2026-10-15T07:00:00.000Z", localSkewed);
    expect(msUntil("2026-10-15T07:01:00.000Z", localSkewed, offset)).toBe(60_000);
  });

  it("formats m:ss rounding up", () => {
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(42_000)).toBe("0:42");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(299_500)).toBe("5:00");
  });
});
