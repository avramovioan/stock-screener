import type { BrokerConnection, BrokerRun } from "./broker-api";

export type StatusIcon = "plug-off" | "check" | "alert" | "clock" | "loader";

export interface ConnectionDescription {
  label: string;
  icon: StatusIcon;
  detail: string | null;
}

export function runActive(run: BrokerRun | null): boolean {
  return (
    run !== null &&
    (run.state === "queued" ||
      run.state === "requested" ||
      run.state === "polling" ||
      run.state === "parsing")
  );
}

export function runLabel(state: BrokerRun["state"]): string {
  switch (state) {
    case "queued":
      return "Waiting to start";
    case "requested":
      return "Statement requested from IBKR";
    case "polling":
      return "Waiting for IBKR to generate the statement";
    case "parsing":
      return "Reading the statement";
    case "done":
      return "Finished";
    case "failed":
      return "Failed";
    case "expired":
      return "Token expired";
  }
}

export function describeConnection(
  conn: BrokerConnection | null,
  run: BrokerRun | null,
): ConnectionDescription {
  if (conn === null || conn.status === "unlinked")
    return { label: "Not linked", icon: "plug-off", detail: null };
  if (conn.status === "expired") return { label: "Token expired", icon: "clock", detail: null };
  if (conn.status === "error") return { label: "Needs attention", icon: "alert", detail: null };
  if (conn.status === "linking")
    return {
      label: "Verifying",
      icon: "loader",
      detail: run !== null ? runLabel(run.state) : "Verifying with IBKR",
    };
  return {
    label: "Linked",
    icon: "check",
    detail: runActive(run) && run !== null ? runLabel(run.state) : null,
  };
}

const DAY_MS = 86_400_000;

/** Banner rule of spec 12.3: from 14 days before the user-entered expiry date. */
export function tokenExpiry(
  expiresOn: string | null,
  now: Date,
): { kind: "soon" | "expired"; days: number } | null {
  if (expiresOn === null) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = Date.parse(`${expiresOn}T00:00:00Z`);
  const days = Math.round((target - today) / DAY_MS);
  if (days <= 0) return { kind: "expired", days: Math.abs(days) };
  return days <= 14 ? { kind: "soon", days } : null;
}
