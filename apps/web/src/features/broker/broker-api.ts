export type BrokerStatus = "unlinked" | "linking" | "linked" | "error" | "expired";

export interface BrokerConnection {
  id: string;
  status: BrokerStatus;
  token_expires_on: string | null;
  query_id: string | null;
  account_id_masked: string | null;
  base_currency: string | null;
  account_type: string | null;
  linked_at: string | null;
  last_verified_at: string | null;
  last_sync_at: string | null;
  last_statement_date: string | null;
  last_error_code: number | null;
  last_error_message: string | null;
  last_error_at: string | null;
  coverage_from: string | null;
}

export interface SectionReport {
  section: string;
  present: boolean;
  missingFields: string[];
}

export interface BrokerRun {
  id: string;
  kind: "verify" | "daily" | "manual" | "backfill";
  state: "queued" | "requested" | "polling" | "parsing" | "done" | "failed" | "expired";
  error_code: number | null;
  error_message: string | null;
  rows_summary: {
    sections?: SectionReport[];
    positions?: number;
    trades?: number;
    closed_lots?: number;
    warnings?: string[];
  };
  statement_from?: string | null;
  statement_to?: string | null;
}

export interface BrokerSnapshot {
  connection: BrokerConnection | null;
  run: BrokerRun | null;
}

export type ActionResult =
  | { ok: true; connection: BrokerConnection | null; run: BrokerRun | null }
  | { ok: false; kind: "invalid_input"; field: string; message: string }
  | { ok: false; kind: "cooldown"; retryAfterSeconds: number }
  | { ok: false; kind: "busy" }
  | { ok: false; kind: "not_linked" }
  | { ok: false; kind: "failed"; message: string };

export interface LinkInput {
  token: string;
  queryId: string;
  tokenExpiresOn: string;
}

export interface BrokerApi {
  readSnapshot(): Promise<BrokerSnapshot>;
  link(input: LinkInput): Promise<ActionResult>;
  test(): Promise<ActionResult>;
  sync(): Promise<ActionResult>;
  unlink(o: { deleteData: boolean }): Promise<ActionResult>;
}

export interface BrokerApiOptions {
  readSnapshot(): Promise<BrokerSnapshot>;
  /** POST to the broker-sync function with the user's session; the token is only ever in this request body, over HTTPS */
  call(body: Record<string, unknown>): Promise<Response>;
}

export function createBrokerApi(o: BrokerApiOptions): BrokerApi {
  async function act(body: Record<string, unknown>): Promise<ActionResult> {
    let res: Response;
    try {
      res = await o.call(body);
    } catch {
      return { ok: false, kind: "failed", message: "Network error: could not reach the server." };
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok)
      return {
        ok: true,
        connection: (payload["connection"] as BrokerConnection | null | undefined) ?? null,
        run: (payload["run"] as BrokerRun | null | undefined) ?? null,
      };
    if (res.status === 400 && payload["error"] === "invalid_input") {
      return {
        ok: false,
        kind: "invalid_input",
        field: String(payload["field"] ?? ""),
        message: String(payload["message"] ?? "Check the value."),
      };
    }
    if (res.status === 429) {
      const retry =
        Number(res.headers.get("retry-after")) || Number(payload["retryAfterSeconds"]) || 600;
      return { ok: false, kind: "cooldown", retryAfterSeconds: retry };
    }
    if (res.status === 409)
      return payload["error"] === "not_linked"
        ? { ok: false, kind: "not_linked" }
        : { ok: false, kind: "busy" };
    return { ok: false, kind: "failed", message: `The request failed (HTTP ${res.status}).` };
  }
  return {
    readSnapshot: o.readSnapshot,
    link: (input) =>
      act({
        action: "link",
        token: input.token,
        queryId: input.queryId,
        tokenExpiresOn: input.tokenExpiresOn,
      }),
    test: () => act({ action: "test" }),
    sync: () => act({ action: "sync" }),
    unlink: ({ deleteData }) => act({ action: "unlink", deleteData }),
  };
}
