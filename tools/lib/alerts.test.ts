import { describe, expect, it } from "vitest";
import { evaluateAlerts } from "./alerts.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const status = (
  over: {
    finished?: string | null;
    published?: string | null;
    processed?: number;
    total?: number;
  } = {},
) => ({
  last_successful: { finished_at: over.finished === undefined ? hoursAgo(5) : over.finished },
  latest_published: {
    results_published_at: over.published === undefined ? hoursAgo(5) : over.published,
    coverage: { candidates: { total: over.total ?? 40, processed: over.processed ?? 40 } },
  },
});

describe("evaluateAlerts", () => {
  it("is quiet for a fresh, complete scan", () => {
    expect(
      evaluateAlerts({ status: status(), health: { ok: true, db: { size_mb: 120 } }, nowMs: NOW }),
    ).toEqual([]);
  });
  it("flags a scan older than 36 hours and a missing record", () => {
    expect(
      evaluateAlerts({ status: status({ finished: hoursAgo(40) }), health: null, nowMs: NOW })[0],
    ).toMatch(/40\.0 h ago/);
    expect(
      evaluateAlerts({ status: status({ finished: null }), health: null, nowMs: NOW }),
    ).toContain("no successful scan on record");
  });
  it("counts skipped and insufficient-data candidates as covered (list_coverage)", () => {
    const base = status();
    const covered = {
      ...base,
      latest_published: {
        ...base.latest_published,
        coverage: { candidates: { total: 491, processed: 432, skipped: 0, insufficient_data: 58 } },
      },
    };
    expect(
      evaluateAlerts({ status: covered, health: { ok: true, db: { size_mb: 120 } }, nowMs: NOW }),
    ).toEqual([]);
  });
  it("flags a stale published result and low coverage", () => {
    const p = evaluateAlerts({
      status: status({ published: hoursAgo(50), processed: 30, total: 40 }),
      health: null,
      nowMs: NOW,
    });
    expect(p.join("\n")).toMatch(/published result is 50\.0 h old/);
    expect(p.join("\n")).toMatch(/coverage 75\.0%/);
  });
  it("flags health failures and a database above 400 MB", () => {
    const p = evaluateAlerts({
      status: status(),
      health: { ok: false, db: { size_mb: 401 } },
      nowMs: NOW,
    });
    expect(p).toEqual(["health reports ok=false", "database size 401 MB exceeds 400 MB"]);
  });
  it("lets the limit be lowered to force a deliberate failure", () => {
    expect(
      evaluateAlerts({ status: status(), health: null, nowMs: NOW, maxAgeHours: 0 }).length,
    ).toBe(2);
  });
});

describe("evaluateAlerts with skipped scans", () => {
  const skipped = (h: number) => ({
    last_skipped: { scan_date_local: "2026-10-19", at: hoursAgo(h) },
  });
  it("a recent skipped scan keeps a 60 hour old last success quiet (Sunday and Monday have no new close)", () => {
    const s = { ...status({ finished: hoursAgo(60), published: hoursAgo(60) }), ...skipped(2) };
    expect(evaluateAlerts({ status: s, health: { ok: true }, nowMs: NOW })).toEqual([]);
  });
  it("a skip that is itself older than the limit does not make the scan healthy", () => {
    const s = { ...status({ finished: hoursAgo(80), published: hoursAgo(80) }), ...skipped(40) };
    const out = evaluateAlerts({ status: s, health: null, nowMs: NOW });
    expect(out.join("\n")).toMatch(/80\.0 h ago/);
  });
  it("a skip never hides a scan that is more than four days old", () => {
    const s = { ...status({ finished: hoursAgo(110), published: hoursAgo(110) }), ...skipped(1) };
    expect(evaluateAlerts({ status: s, health: null, nowMs: NOW }).join("\n")).toMatch(/110\.0 h/);
  });
  it("a skip older than the last success changes nothing", () => {
    const s = { ...status({ finished: hoursAgo(40) }), ...skipped(90) };
    expect(evaluateAlerts({ status: s, health: null, nowMs: NOW })[0]).toMatch(/40\.0 h ago/);
  });
  it("still reports a missing success when only skips exist", () => {
    const s = { ...status({ finished: null, published: null }), ...skipped(1) };
    expect(evaluateAlerts({ status: s, health: null, nowMs: NOW })).toContain(
      "no successful scan on record",
    );
  });
});

describe("evaluateAlerts message ages", () => {
  it("prints the age of the last success, not of the skip, while the skip sets the threshold", () => {
    const s = {
      ...status({ finished: hoursAgo(50), published: hoursAgo(50) }),
      last_skipped: { scan_date_local: "2026-10-19", at: hoursAgo(40) },
    };
    const out = evaluateAlerts({ status: s, health: null, nowMs: NOW }).join("\n");
    expect(out).toMatch(/finished 50\.0 h ago/);
    expect(out).toMatch(/published result is 50\.0 h old/);
    expect(out).not.toMatch(/40\.0 h/);
  });
  it("is quiet while the skip is within the limit even though the success is older", () => {
    const s = {
      ...status({ finished: hoursAgo(50), published: hoursAgo(50) }),
      last_skipped: { scan_date_local: "2026-10-19", at: hoursAgo(10) },
    };
    expect(evaluateAlerts({ status: s, health: null, nowMs: NOW })).toEqual([]);
  });
});
