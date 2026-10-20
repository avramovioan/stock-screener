import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BrokerConnection, BrokerRun } from "../broker-api";
import { StatusCard } from "./status-card";

const conn = (o: Partial<BrokerConnection> = {}): BrokerConnection => ({
  id: "c",
  status: "linked",
  token_expires_on: "2027-06-01",
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
const NOW = new Date("2026-10-15T08:00:00Z");

describe("StatusCard", () => {
  it("not linked", () => {
    render(<StatusCard connection={null} run={null} now={NOW} />);
    expect(screen.getByText("Not linked")).toBeTruthy();
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("linked shows account, base currency and the timestamps in Sofia time, never the token", () => {
    render(<StatusCard connection={conn()} run={run()} now={NOW} />);
    expect(screen.getByText("Linked")).toBeTruthy();
    expect(screen.getByText("U***4567")).toBeTruthy();
    expect(screen.getByText("EUR")).toBeTruthy();
    expect(screen.getByText("15 Oct 2026, 08:00")).toBeTruthy();
    expect(screen.getByText("14 Oct 2026")).toBeTruthy();
    expect(screen.getByText(/History loaded from/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token\s*[:=]/i);
  });

  it("a running sync is visible with its step", () => {
    render(<StatusCard connection={conn()} run={run({ state: "polling" })} now={NOW} />);
    expect(screen.getByText("Waiting for IBKR to generate the statement")).toBeTruthy();
  });

  it("error shows the last error with its hint and the statement section checklist with the exact missing fields", () => {
    render(
      <StatusCard
        connection={conn({
          status: "error",
          last_error_code: -6,
          last_error_at: "2026-10-15T05:02:00Z",
        })}
        run={run({
          kind: "verify",
          state: "failed",
          error_code: -6,
          rows_summary: {
            sections: [
              { section: "Account Information", present: true, missingFields: [] },
              { section: "Open Positions", present: true, missingFields: ["Cost Basis Money"] },
              { section: "Cash Transactions", present: false, missingFields: [] },
            ],
          },
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/missing required sections or fields/)).toBeTruthy();
    expect(screen.getByText("Open Positions: found, fields missing")).toBeTruthy();
    expect(screen.getByText("Missing fields: Cost Basis Money")).toBeTruthy();
    expect(screen.getByText("Cash Transactions: missing")).toBeTruthy();
  });

  it("expired shows the 1012 guidance", () => {
    render(
      <StatusCard
        connection={conn({ status: "expired", last_error_code: 1012 })}
        run={null}
        now={NOW}
      />,
    );
    expect(screen.getByText("Token expired")).toBeTruthy();
    expect(screen.getByText(/Generate a new token in Client Portal/)).toBeTruthy();
  });

  it("warns 14 days before the token expires and when it has expired", () => {
    const { rerender } = render(
      <StatusCard connection={conn({ token_expires_on: "2026-10-22" })} run={null} now={NOW} />,
    );
    expect(screen.getByText(/Your Flex token expires in 7 days/)).toBeTruthy();
    rerender(
      <StatusCard connection={conn({ token_expires_on: "2026-10-10" })} run={null} now={NOW} />,
    );
    expect(screen.getByText(/Your Flex token expired 5 days ago/)).toBeTruthy();
  });

  it("a linked connection with a failed daily sync shows the error but stays Linked", () => {
    render(
      <StatusCard
        connection={conn({ last_error_code: 1021, last_error_at: "2026-10-15T05:30:00Z" })}
        run={run({ state: "failed", error_code: 1021 })}
        now={NOW}
      />,
    );
    expect(screen.getByText("Linked")).toBeTruthy();
    expect(screen.getByText(/IBKR could not deliver the statement yet/)).toBeTruthy();
  });
});
