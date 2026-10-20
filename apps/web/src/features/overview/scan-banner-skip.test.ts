import { describe, expect, it } from "vitest";
import { makeScanStatus } from "@/test/fixtures";
import { deriveScanBanner, STALE_AFTER_MS } from "./scan-banner";

const HOUR = 3_600_000;
// last success: 2026-10-15T07:41Z
const SUCCESS_AT = Date.parse("2026-10-15T07:41:00Z");
const skipped = (at: string) => ({
  scan_date_local: "2026-10-18",
  at,
  reason: "no_new_session",
  scope: "all",
});

describe("deriveScanBanner with a skipped scan", () => {
  it("without a skip, 40 hours after the last success is stale", () => {
    const now = SUCCESS_AT + 40 * HOUR;
    expect(deriveScanBanner(makeScanStatus({ last_skipped: null }), now).state).toBe("stale");
    expect(deriveScanBanner(makeScanStatus(), now).state).toBe("stale");
  });

  it("a skip newer than the success counts as fresh", () => {
    const now = SUCCESS_AT + 60 * HOUR;
    const status = makeScanStatus({
      last_skipped: skipped(new Date(SUCCESS_AT + 50 * HOUR).toISOString()),
    });
    expect(deriveScanBanner(status, now)).toEqual({ state: "ok" });
  });

  it("a skip older than the success changes nothing", () => {
    const now = SUCCESS_AT + 40 * HOUR;
    const status = makeScanStatus({
      last_skipped: skipped(new Date(SUCCESS_AT - 5 * HOUR).toISOString()),
    });
    expect(deriveScanBanner(status, now).state).toBe("stale");
  });

  it("a skip itself that is older than 36 hours does not keep it fresh", () => {
    const now = SUCCESS_AT + 90 * HOUR;
    const status = makeScanStatus({
      last_skipped: skipped(new Date(SUCCESS_AT + 40 * HOUR).toISOString()),
    });
    expect(deriveScanBanner(status, now).state).toBe("stale");
  });

  it("the skip covers a success at most 96 hours old", () => {
    const skip = skipped(new Date(SUCCESS_AT + 90 * HOUR).toISOString());
    const within = SUCCESS_AT + 96 * HOUR;
    expect(deriveScanBanner(makeScanStatus({ last_skipped: skip }), within).state).toBe("ok");
    const beyond = SUCCESS_AT + 97 * HOUR;
    const banner = deriveScanBanner(makeScanStatus({ last_skipped: skip }), beyond);
    expect(banner.state).toBe("stale");
    // the age printed is the real age of the success, not of the skip
    expect("ageHours" in banner && banner.ageHours).toBe(97);
  });

  it("the stale limit is still 36 hours", () => {
    expect(STALE_AFTER_MS).toBe(36 * HOUR);
  });
});
