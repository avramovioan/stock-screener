import { describe, expect, it } from "vitest";
import type { BrokerConnection, BrokerRun } from "./broker-api";
import { describeConnection, runActive, runLabel, tokenExpiry } from "./broker-view";

const conn = (o: Partial<BrokerConnection> = {}): BrokerConnection => ({
  id: "c",
  status: "linked",
  token_expires_on: "2027-01-01",
  query_id: "123456",
  account_id_masked: "U***4567",
  base_currency: "EUR",
  account_type: "Individual",
  linked_at: "2026-10-01T00:00:00Z",
  last_verified_at: "2026-10-15T05:00:00Z",
  last_sync_at: "2026-10-15T05:01:00Z",
  last_statement_date: "2026-10-14",
  last_error_code: null,
  last_error_message: null,
  last_error_at: null,
  coverage_from: "2025-10-15",
  ...o,
});
const run = (o: Partial<BrokerRun> = {}): BrokerRun => ({
  id: "r",
  kind: "daily",
  state: "done",
  error_code: null,
  error_message: null,
  rows_summary: {},
  ...o,
});

describe("describeConnection", () => {
  it("no connection and unlinked are Not linked", () => {
    expect(describeConnection(null, null).label).toBe("Not linked");
    expect(describeConnection(conn({ status: "unlinked" }), null).label).toBe("Not linked");
  });
  it("every status has a text label and a distinct icon name (never colour alone)", () => {
    const seen = new Set<string>();
    for (const [status, label] of [
      ["linked", "Linked"],
      ["error", "Needs attention"],
      ["expired", "Token expired"],
      ["linking", "Verifying"],
    ] as const) {
      const d = describeConnection(conn({ status }), null);
      expect(d.label).toBe(label);
      seen.add(d.icon);
    }
    seen.add(describeConnection(null, null).icon);
    expect(seen.size).toBe(5);
  });
  it("an active run turns a linked connection into a visible sync in progress", () => {
    expect(describeConnection(conn(), run({ state: "polling" })).detail).toBe(
      "Waiting for IBKR to generate the statement",
    );
  });
});

describe("runs", () => {
  it("runActive is true for queued, requested, polling and parsing only", () => {
    for (const state of ["queued", "requested", "polling", "parsing"] as const)
      expect(runActive(run({ state }))).toBe(true);
    for (const state of ["done", "failed", "expired"] as const)
      expect(runActive(run({ state }))).toBe(false);
    expect(runActive(null)).toBe(false);
  });
  it("runLabel is plain language", () => {
    expect(runLabel("requested")).toBe("Statement requested from IBKR");
    expect(runLabel("parsing")).toBe("Reading the statement");
  });
});

describe("tokenExpiry (banner 14 days before expiry, spec 12.3)", () => {
  const today = new Date("2026-10-15T08:00:00Z");
  it("is null when far away or unknown", () => {
    expect(tokenExpiry("2027-01-01", today)).toBeNull();
    expect(tokenExpiry(null, today)).toBeNull();
  });
  it("is soon within 14 days, with the number of days", () => {
    expect(tokenExpiry("2026-10-29", today)).toEqual({ kind: "soon", days: 14 });
    expect(tokenExpiry("2026-10-16", today)).toEqual({ kind: "soon", days: 1 });
    expect(tokenExpiry("2026-10-30", today)).toBeNull();
  });
  it("is expired on and after the expiry date", () => {
    expect(tokenExpiry("2026-10-15", today)).toEqual({ kind: "expired", days: 0 });
    expect(tokenExpiry("2026-10-01", today)).toEqual({ kind: "expired", days: 14 });
  });
});
