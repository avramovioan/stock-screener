import { describe, expect, it } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import {
  COOLDOWN_HOURS,
  isStale,
  pausedLine,
  RETRY_MINUTES,
  researchView,
  waitLine,
} from "./research-state";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const unscanned = (over = {}) =>
  makeDiscount({
    operational_category: "pending",
    category_reason: "not_requested",
    withheld: true,
    research_completed_at: null,
    conclusion: null,
    summary: null,
    bankruptcy_risk: null,
    ...over,
  });

describe("researchView", () => {
  it("no report and nothing in flight is not scanned", () => {
    expect(researchView(unscanned(), NOW)).toEqual({ kind: "not_scanned" });
  });

  it("an in-flight report is running, with who asked", () => {
    const v = researchView(
      unscanned({
        category_reason: "research_pending",
        research_started_at: ago(12),
        research_requested_by: "visitor",
      }),
      NOW,
    );
    expect(v).toEqual({
      kind: "running",
      startedAt: ago(12),
      requestedBy: "visitor",
      waitReason: null,
    });
  });

  it("a queued report without a start time is still running", () => {
    expect(researchView(unscanned({ research_requested_by: "owner" }), NOW)).toMatchObject({
      kind: "running",
      startedAt: null,
    });
    expect(researchView(unscanned({ research_wait_reason: "rate_limited" }), NOW)).toMatchObject({
      kind: "running",
      waitReason: "rate_limited",
    });
  });

  it("pending or quota-deferred card reasons alone are not in flight: the card is not scanned", () => {
    for (const reason of ["research_pending", "research_quota_deferred"]) {
      expect(researchView(unscanned({ category_reason: reason }), NOW)).toEqual({
        kind: "not_scanned",
      });
    }
  });

  it("a complete report within 72 hours is done, with the time a new scan can be requested", () => {
    const v = researchView(makeDiscount({ research_completed_at: ago(2 * 60) }), NOW);
    expect(v).toEqual({
      kind: "done",
      rescanAt: new Date(NOW.getTime() + 70 * 3_600_000).toISOString(),
      canRescan: false,
    });
  });

  it("frees the scan once the 72 hours have passed", () => {
    const v = researchView(makeDiscount({ research_completed_at: ago(COOLDOWN_HOURS * 60) }), NOW);
    expect(v).toMatchObject({ kind: "done", canRescan: true });
    expect(
      researchView(makeDiscount({ research_completed_at: ago(71 * 60 + 30) }), NOW),
    ).toMatchObject({
      canRescan: false,
    });
  });

  it("a complete report newer than the in-flight start decides the card, even with a parked wait reason", () => {
    const v = researchView(
      makeDiscount({
        research_completed_at: ago(60),
        research_started_at: ago(600),
        research_wait_reason: "llm_quota",
        research_requested_by: "visitor",
      }),
      NOW,
    );
    expect(v.kind).toBe("done");
  });

  it("a failed report with providers_busy is busy until 15 minutes after it failed", () => {
    expect(
      researchView(
        unscanned({ research_failed_at: ago(5), research_failed_reason: "providers_busy" }),
        NOW,
      ),
    ).toEqual({ kind: "busy", retryAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
  });

  it("a failed report with no_quota is its own state", () => {
    expect(
      researchView(
        unscanned({ research_failed_at: ago(5), research_failed_reason: "no_quota" }),
        NOW,
      ),
    ).toEqual({ kind: "no_quota" });
  });

  it("any other failure reason keeps the plain failed state", () => {
    expect(
      researchView(
        unscanned({ research_failed_at: ago(20), research_failed_reason: "llm_error" }),
        NOW,
      ),
    ).toEqual({ kind: "failed", retryInMinutes: RETRY_MINUTES - 20 });
  });

  it("a complete report older than 30 days is not scanned again", () => {
    expect(researchView(makeDiscount({ research_completed_at: ago(31 * 24 * 60) }), NOW)).toEqual({
      kind: "not_scanned",
    });
  });

  it("a failed report is failed, with the minutes until a retry is allowed", () => {
    expect(researchView(unscanned({ research_failed_at: ago(20) }), NOW)).toEqual({
      kind: "failed",
      retryInMinutes: RETRY_MINUTES - 20,
    });
    expect(researchView(unscanned({ research_failed_at: ago(90) }), NOW)).toEqual({
      kind: "failed",
      retryInMinutes: 0,
    });
  });

  it("running wins over failed and over done (a re-scan in flight)", () => {
    expect(
      researchView(unscanned({ research_failed_at: ago(90), research_started_at: ago(3) }), NOW)
        .kind,
    ).toBe("running");
    expect(
      researchView(
        makeDiscount({ research_completed_at: ago(80 * 60), research_started_at: ago(3) }),
        NOW,
      ).kind,
    ).toBe("running");
  });

  it("a complete report newer than the failure keeps the card done", () => {
    expect(
      researchView(
        makeDiscount({ research_completed_at: ago(60), research_failed_at: ago(600) }),
        NOW,
      ).kind,
    ).toBe("done");
  });
});

describe("waitLine", () => {
  it("names a provider that is busy or a day's quota that is spent", () => {
    expect(waitLine("rate_limited")).toBe("Provider busy, retrying");
    expect(waitLine("provider_unavailable")).toBeNull();
    expect(waitLine("llm_quota")).toBeNull();
    expect(waitLine(null)).toBeNull();
    expect(waitLine("weekend")).toBeNull();
  });
});

describe("paused", () => {
  it.each([
    ["llm_quota", "Today's free AI budget is used up."],
    ["search_quota", "Today's free search budget is used up."],
    ["provider_unavailable", "The AI provider is unavailable right now."],
    ["weekend", "No AI work at the weekend."],
    ["cadence_72h", "Waiting for the 72-hour window."],
  ])("%s is its own paused state", (reason, line) => {
    const v = researchView(
      unscanned({
        research_started_at: ago(300),
        research_requested_by: "owner",
        research_wait_reason: reason,
        next_attempt_at: "2026-10-20T06:00:00Z",
      }),
      NOW,
    );
    expect(v).toEqual({ kind: "paused", reason, nextAttemptAt: "2026-10-20T06:00:00Z" });
    expect(pausedLine(reason)).toBe(line);
  });

  it("rate_limited stays running", () => {
    expect(
      researchView(
        unscanned({ research_started_at: ago(30), research_wait_reason: "rate_limited" }),
        NOW,
      ).kind,
    ).toBe("running");
  });
});

describe("isStale", () => {
  it("is true only past 90 minutes", () => {
    expect(isStale(ago(30), NOW)).toBe(false);
    expect(isStale(ago(120), NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(false);
  });
});
