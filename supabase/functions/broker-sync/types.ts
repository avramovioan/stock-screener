import type { Sealed } from "@adapters/crypto.ts";
import type { FlexClient } from "@adapters/flex.ts";
import type { ParseResult } from "@adapters/flex-parse.ts";
import type { IngestPayload } from "./persist.ts";

export type BrokerStatus = "unlinked" | "linking" | "linked" | "error" | "expired";
export type SyncState =
  | "queued"
  | "requested"
  | "polling"
  | "parsing"
  | "done"
  | "failed"
  | "expired";
export type RunKind = "verify" | "daily" | "manual" | "backfill";

export const ACTIVE_STATES: readonly SyncState[] = ["queued", "requested", "polling", "parsing"];
export const isTerminal = (state: SyncState): boolean => !ACTIVE_STATES.includes(state);

export interface ConnectionRow {
  id: string;
  user_id: string;
  status: BrokerStatus;
  /** PostgREST bytea hex (`\x...`); never leaves this function */
  flex_token_ciphertext: string | null;
  flex_token_iv: string | null;
  key_version: number | null;
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
  next_flex_fetch_not_before: string | null;
  coverage_from: string | null;
}

export interface RunRow {
  id: string;
  user_id: string;
  connection_id: string;
  kind: RunKind;
  state: SyncState;
  reference_code: string | null;
  requested_at: string | null;
  poll_count: number;
  next_poll_at: string | null;
  statement_from: string | null;
  statement_to: string | null;
  error_code: number | null;
  error_message: string | null;
  rows_summary: Record<string, unknown>;
  idempotency_key: string;
}

export interface RunPatch {
  state?: SyncState;
  reference_code?: string | null;
  requested_at?: string | null;
  last_poll_at?: string | null;
  poll_count?: number;
  next_poll_at?: string | null;
  error_code?: number | null;
  error_message?: string | null;
  rows_summary?: Record<string, unknown>;
  lease_until?: string | null;
  finished_at?: string | null;
}

export interface ConnectionPatch {
  status?: BrokerStatus;
  last_error_code?: number | null;
  last_error_message?: string | null;
  last_error_at?: string | null;
  last_verified_at?: string | null;
  linked_at?: string | null;
  account_id_masked?: string | null;
}

export interface AuditEvent {
  actorUserId: string | null;
  actor: "user" | "service" | "admin";
  eventType: string;
  data: Record<string, unknown>;
}

export interface SyncStore {
  getConnection(userId: string): Promise<ConnectionRow | null>;
  getConnectionById(id: string): Promise<ConnectionRow | null>;
  upsertLinking(input: {
    id: string;
    userId: string;
    sealed: Sealed;
    queryId: string;
    tokenExpiresOn: string;
  }): Promise<ConnectionRow>;
  patchConnection(id: string, patch: ConnectionPatch): Promise<void>;
  zeroToken(connectionId: string): Promise<void>;
  deleteBrokerData(userId: string, o?: { includeRuns?: boolean }): Promise<void>;
  cancelActiveRuns(userId: string, reason: string): Promise<void>;
  /** null when the user already has an active run or the idempotency key exists */
  createRun(input: {
    userId: string;
    connectionId: string;
    kind: RunKind;
    statementFrom: string | null;
    statementTo: string | null;
    idempotencyKey: string;
  }): Promise<RunRow | null>;
  getRun(id: string): Promise<RunRow | null>;
  latestActiveRun(userId: string): Promise<RunRow | null>;
  leaseRun(id: string, seconds: number): Promise<RunRow | null>;
  claimRuns(limit: number, leaseSeconds: number): Promise<RunRow[]>;
  patchRun(id: string, patch: RunPatch): Promise<RunRow>;
  enqueueManualSync(userId: string): Promise<{
    runId: string | null;
    outcome: "created" | "busy" | "cooldown" | "not_linked";
    retryAfterSeconds: number;
  }>;
  ingest(runId: string, payload: IngestPayload): Promise<Record<string, number>>;
  listConnectionsForRekey(currentVersion: number): Promise<ConnectionRow[]>;
  rekeyConnection(id: string, sealed: Sealed): Promise<void>;
  isAdmin(userId: string): Promise<boolean>;
  audit(event: AuditEvent): Promise<void>;
}

export interface MatchSummary {
  matched: number;
  unmatched: number;
  notEquity: number;
}

export interface BrokerDeps {
  store: SyncStore;
  flex: FlexClient;
  keys: {
    seal(plain: string, ctx: { userId: string; connectionId: string }): Promise<Sealed>;
    open(sealed: Sealed, ctx: { userId: string; connectionId: string }): Promise<string>;
    currentVersion(): number;
  };
  parse(xml: string): ParseResult;
  matcher: { matchUserPositions(userId: string): Promise<MatchSummary> };
  riskSet: {
    refresh(userId: string): Promise<{ monitored: number }>;
    pause(userId: string): Promise<void>;
    remove(userId: string): Promise<void>;
  };
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run ids, counts and error codes only: never tokens, symbols, amounts or account ids. */
  log(event: string, data?: Record<string, unknown>): void;
}

export interface PublicConnection {
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

/** Allow-list: the ciphertext, IV and key version can never be copied into a response by accident. */
export function publicConnection(c: ConnectionRow): PublicConnection {
  return {
    id: c.id,
    status: c.status,
    token_expires_on: c.token_expires_on,
    query_id: c.query_id,
    account_id_masked: c.account_id_masked,
    base_currency: c.base_currency,
    account_type: c.account_type,
    linked_at: c.linked_at,
    last_verified_at: c.last_verified_at,
    last_sync_at: c.last_sync_at,
    last_statement_date: c.last_statement_date,
    last_error_code: c.last_error_code,
    last_error_message: c.last_error_message,
    last_error_at: c.last_error_at,
    coverage_from: c.coverage_from,
  };
}

const SUMMARY_KEYS = [
  "positions",
  "trades",
  "closed_lots",
  "cash",
  "fx",
  "nav",
  "corporate_actions",
  "sections",
  "warnings",
  "match",
  "match_error",
  "restarted",
];

export interface PublicRun {
  id: string;
  kind: RunKind;
  state: SyncState;
  poll_count: number;
  statement_from: string | null;
  statement_to: string | null;
  error_code: number | null;
  error_message: string | null;
  rows_summary: Record<string, unknown>;
}

export function publicRun(r: RunRow): PublicRun {
  const rows_summary: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS)
    if (key in r.rows_summary) rows_summary[key] = r.rows_summary[key];
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    poll_count: r.poll_count,
    statement_from: r.statement_from,
    statement_to: r.statement_to,
    error_code: r.error_code,
    error_message: r.error_message,
    rows_summary,
  };
}
