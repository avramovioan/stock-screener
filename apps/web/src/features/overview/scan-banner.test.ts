import { describe, expect, it } from "vitest";
import { makeScanStatus } from "@/test/fixtures";
import { deriveScanBanner, STALE_AFTER_MS } from "./scan-banner";

const NOW = Date.parse("2026-10-15T12:00:00Z");

describe("deriveScanBanner", () => {
  it("is ok for a recent complete scan", () => {
    expect(deriveScanBanner(makeScanStatus(), NOW)).toEqual({ state: "ok" });
  });
  it("is none when there is no data or no completed scan at all", () => {
    expect(deriveScanBanner(undefined, NOW)).toEqual({ state: "none" });
    expect(
      deriveScanBanner(makeScanStatus({ last_successful: null, latest_published: null }), NOW),
    ).toEqual({ state: "none" });
  });
  it("is failed when the latest attempt failed, even if an older scan succeeded", () => {
    const s = makeScanStatus({
      last_attempted: {
        scan_date_local: "2026-10-15",
        started_at: "2026-10-15T07:00:00Z",
        status: "failed",
      },
    });
    expect(deriveScanBanner(s, NOW).state).toBe("failed");
  });
  it("is partial when the published run is partial, with the coverage numbers", () => {
    const base = makeScanStatus();
    const s = makeScanStatus({
      latest_published: {
        ...(base.latest_published as NonNullable<typeof base.latest_published>),
        status: "partial",
        coverage: { candidates: { total: 612, processed: 590 } },
      },
    });
    expect(deriveScanBanner(s, NOW)).toEqual({ state: "partial", processed: 590, total: 612 });
  });
  it("passes the insufficient-data count through", () => {
    const base = makeScanStatus();
    const s = makeScanStatus({
      latest_published: {
        ...base.latest_published!,
        status: "partial",
        coverage: {
          candidates: { total: 491, processed: 432, unprocessed: 1, insufficient_data: 58 },
        },
      },
    });
    expect(deriveScanBanner(s, NOW)).toEqual({
      state: "partial",
      processed: 432,
      total: 491,
      insufficientData: 58,
    });
  });
  it("passes the skipped count through", () => {
    const base = makeScanStatus();
    const s = makeScanStatus({
      latest_published: {
        ...base.latest_published!,
        status: "partial",
        coverage: {
          candidates: { total: 490, processed: 431, skipped: 1, insufficient_data: 58 },
        },
      },
    });
    expect(deriveScanBanner(s, NOW)).toEqual({
      state: "partial",
      processed: 431,
      total: 490,
      insufficientData: 58,
      skipped: 1,
    });
  });
  it("is partial when the list was not published", () => {
    const base = makeScanStatus();
    const s = makeScanStatus({
      latest_published: {
        ...(base.latest_published as NonNullable<typeof base.latest_published>),
        coverage: { publish: { results: true, list: false, list_coverage: 0.9 } },
      },
    });
    expect(deriveScanBanner(s, NOW).state).toBe("partial");
  });
  it("is partial when no run ever completed but results exist", () => {
    expect(deriveScanBanner(makeScanStatus({ last_successful: null }), NOW).state).toBe("partial");
  });
  it("is stale only after 36 hours", () => {
    const at = (ms: number) =>
      makeScanStatus({
        last_successful: {
          scan_date_local: "2026-10-14",
          finished_at: new Date(NOW - ms).toISOString(),
        },
      });
    expect(deriveScanBanner(at(STALE_AFTER_MS - 60_000), NOW).state).toBe("ok");
    expect(deriveScanBanner(at(STALE_AFTER_MS + 60_000), NOW).state).toBe("stale");
  });
  it("stale carries age, last scan time, session date and coverage", () => {
    const s = makeScanStatus({
      last_successful: {
        scan_date_local: "2026-10-13",
        finished_at: new Date(NOW - 50 * 3_600_000).toISOString(),
      },
    });
    expect(deriveScanBanner(s, NOW)).toMatchObject({
      state: "stale",
      ageHours: 50,
      sessionDate: "2026-10-14",
      processed: 612,
      total: 612,
    });
  });
  it("failed outranks partial outranks stale", () => {
    const base = makeScanStatus();
    const s = makeScanStatus({
      last_attempted: {
        scan_date_local: "2026-10-15",
        started_at: "2026-10-15T07:00:00Z",
        status: "failed",
      },
      last_successful: { scan_date_local: "2026-10-10", finished_at: "2026-10-10T07:00:00Z" },
      latest_published: {
        ...(base.latest_published as NonNullable<typeof base.latest_published>),
        status: "partial",
      },
    });
    expect(deriveScanBanner(s, NOW).state).toBe("failed");
  });
});
