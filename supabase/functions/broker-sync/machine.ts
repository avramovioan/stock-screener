// The sync run state machine (spec 12.4): one transition per call, so a user action (bounded inline wait) and the minute tick share it.
import { CryptoError, fromBytea } from "@adapters/crypto.ts";
import type { FlexPeriod } from "@adapters/flex.ts";
import { requiredSectionReport } from "@adapters/flex-parse.ts";
import {
  classifyFlexCode,
  flexErrorInfo,
  MAX_POLLS,
  POLL_DELAYS_S,
  SEND_RETRY_LIMIT,
} from "@core/flex-errors.ts";
import { maskAccountId, toIngestPayload } from "./persist.ts";
import { type BrokerDeps, type ConnectionRow, isTerminal, type RunRow } from "./types.ts";

const iso = (ms: number): string => new Date(ms).toISOString();
const FIRST_POLL_DELAY_MS = 5_000;
const LEASE_SECONDS = 150;
/** 1018 answers tolerated while fetching one statement, and the hard ceiling for a run since its first request. */
const RATE_LIMIT_MAX = 5;
export const MAX_RUN_AGE_MS = 30 * 60_000;

const errName = (e: unknown): string => (e instanceof Error ? e.name : "error");

export async function openToken(d: BrokerDeps, conn: ConnectionRow): Promise<string> {
  if (
    conn.flex_token_ciphertext === null ||
    conn.flex_token_iv === null ||
    conn.key_version === null
  )
    throw new CryptoError("bad_input", "no token stored");
  return await d.keys.open(
    {
      ciphertext: fromBytea(conn.flex_token_ciphertext),
      iv: fromBytea(conn.flex_token_iv),
      version: conn.key_version,
    },
    { userId: conn.user_id, connectionId: conn.id },
  );
}

function periodFor(run: RunRow): FlexPeriod | undefined {
  if (run.kind === "backfill") return { days: 365 };
  if (run.statement_from !== null && run.statement_to !== null) {
    return run.statement_from <= run.statement_to
      ? { from: run.statement_from, to: run.statement_to }
      : { days: 30 };
  }
  return undefined;
}

async function failWith(
  d: BrokerDeps,
  run: RunRow,
  conn: ConnectionRow,
  code: number,
  o: { state?: "failed" | "expired"; detail?: Record<string, unknown> } = {},
): Promise<RunRow> {
  const info = flexErrorInfo(code);
  const state = o.state ?? (info.cls === "expired" ? "expired" : "failed");
  const patched = await d.store.patchRun(run.id, {
    state,
    error_code: code,
    error_message: info.message,
    finished_at: iso(d.now()),
    lease_until: null,
    next_poll_at: null,
    rows_summary: { ...run.rows_summary, ...(o.detail ?? {}) },
  });
  const impact = info.connection ?? (run.kind === "verify" ? "error" : null);
  await d.store.patchConnection(conn.id, {
    ...(impact === null ? {} : { status: impact }),
    last_error_code: code,
    last_error_message: info.message,
    last_error_at: iso(d.now()),
  });
  await d.store.audit({
    actorUserId: conn.user_id,
    actor: "service",
    eventType: run.kind === "verify" ? "broker.test" : "broker.sync_failed",
    data: { run: run.id, result: "failed", code },
  });
  d.log("run_failed", { run: run.id, kind: run.kind, code });
  return patched;
}

async function onFlexError(
  d: BrokerDeps,
  run: RunRow,
  conn: ConnectionRow,
  code: number,
  phase: "send" | "fetch",
): Promise<RunRow> {
  const info = flexErrorInfo(code);
  const unknownSeen = Number(run.rows_summary["unknown_codes"] ?? 0);
  const cls = classifyFlexCode(code, unknownSeen);
  const summary: Record<string, unknown> = {
    ...run.rows_summary,
    ...(info.ibkrText === "(unknown)" ? { unknown_codes: unknownSeen + 1 } : {}),
  };

  if (cls === "expired") return await failWith(d, run, conn, code, { state: "expired" });

  if (cls === "retry") {
    if (phase === "send") {
      const sends = Number(summary["send_attempts"] ?? 0) + 1;
      if (sends >= SEND_RETRY_LIMIT) return await failWith(d, run, conn, -5);
      return await d.store.patchRun(run.id, {
        state: "queued",
        rows_summary: { ...summary, send_attempts: sends },
        next_poll_at: iso(d.now() + (info.retryAfterSeconds ?? 30) * 1000),
        lease_until: null,
      });
    }
    // a rate limit (1018) is not a poll, but persistent throttling must not keep a run active forever
    let limited = Number(summary["rate_limited"] ?? 0);
    if (!info.countsAsPoll) {
      limited += 1;
      summary["rate_limited"] = limited;
      if (limited >= RATE_LIMIT_MAX)
        return await failWith(d, run, conn, -5, { detail: { rate_limited: limited } });
    }
    const polls = run.poll_count + (info.countsAsPoll ? 1 : 0);
    if (info.countsAsPoll && polls >= MAX_POLLS) return await failWith(d, run, conn, -4);
    const delayS = info.countsAsPoll
      ? (POLL_DELAYS_S[Math.min(polls, POLL_DELAYS_S.length) - 1] ?? 60)
      : (info.retryAfterSeconds ?? 60);
    return await d.store.patchRun(run.id, {
      state: "polling",
      poll_count: polls,
      last_poll_at: iso(d.now()),
      next_poll_at: iso(d.now() + delayS * 1000),
      rows_summary: summary,
      lease_until: null,
    });
  }

  if (code === 1017 && summary["restarted"] !== true) {
    return await d.store.patchRun(run.id, {
      state: "queued",
      reference_code: null,
      poll_count: 0,
      rows_summary: { ...summary, restarted: true },
      next_poll_at: iso(d.now() + FIRST_POLL_DELAY_MS),
      lease_until: null,
    });
  }
  return await failWith(d, run, conn, code);
}

/** Parse, validate, ingest (one SQL transaction), match, update the risk set. Nothing is written unless the whole statement is valid. */
export async function processStatement(
  d: BrokerDeps,
  run: RunRow,
  conn: ConnectionRow,
  xml: string,
): Promise<RunRow> {
  await d.store.patchRun(run.id, { state: "parsing" });
  const parsed = d.parse(xml);
  if (!parsed.ok)
    return await failWith(d, run, conn, -1, {
      detail: { parse_code: parsed.code, issues: parsed.issues.slice(0, 20) },
    });
  const statement = parsed.statement;

  const report = requiredSectionReport(statement);
  if (report.some((r) => !r.present || r.missingFields.length > 0))
    return await failWith(d, run, conn, -6, { detail: { sections: report } });

  const masked = maskAccountId(statement.accountId);
  const switched = conn.account_id_masked !== null && conn.account_id_masked !== masked;
  if (switched && run.kind !== "verify") return await failWith(d, run, conn, -3);
  if (switched) {
    await d.store.deleteBrokerData(conn.user_id);
    await d.store.audit({
      actorUserId: conn.user_id,
      actor: "service",
      eventType: "broker.account_changed",
      data: { run: run.id },
    });
  }

  const counts = await d.store.ingest(run.id, await toIngestPayload(conn.user_id, statement));

  let match: Record<string, number> | null = null;
  try {
    match = { ...(await d.matcher.matchUserPositions(conn.user_id)) };
  } catch (e) {
    d.log("match_failed", { run: run.id, error: errName(e) });
  }
  try {
    await d.riskSet.refresh(conn.user_id);
  } catch (e) {
    d.log("risk_set_failed", { run: run.id, error: errName(e) });
  }

  const done = await d.store.patchRun(run.id, {
    state: "done",
    finished_at: iso(d.now()),
    lease_until: null,
    next_poll_at: null,
    error_code: null,
    error_message: null,
    rows_summary: {
      ...run.rows_summary,
      ...counts,
      ...(match === null ? { match_error: true } : { match }),
      sections: report,
      warnings: statement.warnings,
    },
  });

  if (run.kind === "verify") {
    await d.store.patchConnection(conn.id, {
      status: "linked",
      last_verified_at: iso(d.now()),
      linked_at: conn.linked_at ?? iso(d.now()),
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
    });
    if (conn.linked_at === null) {
      await d.store.createRun({
        userId: conn.user_id,
        connectionId: conn.id,
        kind: "backfill",
        statementFrom: null,
        statementTo: null,
        idempotencyKey: `${conn.user_id}:backfill:${run.id}`,
      });
    }
    await d.store.audit({
      actorUserId: conn.user_id,
      actor: "user",
      eventType: "broker.test",
      data: { run: run.id, result: "ok" },
    });
  }
  d.log("run_done", { run: run.id, kind: run.kind });
  return done;
}

export async function advanceRun(d: BrokerDeps, run: RunRow): Promise<RunRow> {
  if (isTerminal(run.state)) return run;
  const conn = await d.store.getConnectionById(run.connection_id);
  if (conn === null || conn.status === "unlinked") {
    return await d.store.patchRun(run.id, {
      state: "failed",
      error_code: -7,
      error_message: "The connection was removed.",
      finished_at: iso(d.now()),
      lease_until: null,
      next_poll_at: null,
    });
  }
  if (run.requested_at !== null && d.now() - Date.parse(run.requested_at) > MAX_RUN_AGE_MS) {
    return await failWith(d, run, conn, -4, { detail: { timeout: true } });
  }
  let token: string;
  try {
    token = await openToken(d, conn);
  } catch (e) {
    if (e instanceof CryptoError) {
      d.log("token_unavailable", { run: run.id, reason: e.code });
      return await failWith(d, run, conn, -2, { detail: { crypto: e.code } });
    }
    throw e;
  }

  if (run.state === "queued") {
    if (conn.query_id === null) return await failWith(d, run, conn, 1014);
    const res = await d.flex.sendRequest(token, conn.query_id, periodFor(run));
    if (res.ok) {
      return await d.store.patchRun(run.id, {
        state: "requested",
        reference_code: res.referenceCode,
        requested_at: run.requested_at ?? iso(d.now()),
        poll_count: 0,
        next_poll_at: iso(d.now() + FIRST_POLL_DELAY_MS),
        lease_until: null,
      });
    }
    return await onFlexError(d, run, conn, res.code, "send");
  }

  if (run.reference_code === null) return await onFlexError(d, run, conn, 1017, "fetch");
  const res = await d.flex.getStatement(token, run.reference_code);
  if (!res.ok) return await onFlexError(d, run, conn, res.code, "fetch");
  return await processStatement(d, run, conn, res.xml);
}

/** Advances a run inline until it is terminal or the next poll would exceed the budget (then the minute tick takes over). */
export async function runUntilSettled(
  d: BrokerDeps,
  runId: string,
  budgetMs: number,
): Promise<RunRow | null> {
  const deadline = d.now() + budgetMs;
  let run = await d.store.leaseRun(runId, LEASE_SECONDS);
  if (run === null) return await d.store.getRun(runId);
  while (!isTerminal(run.state)) {
    run = await advanceRun(d, run);
    if (isTerminal(run.state)) break;
    const due = run.next_poll_at === null ? d.now() : Date.parse(run.next_poll_at);
    const wait = Math.max(0, due - d.now());
    if (d.now() + wait > deadline) break;
    if (wait > 0) await d.sleep(wait);
    const next = await d.store.leaseRun(run.id, LEASE_SECONDS);
    if (next === null) break;
    run = next;
  }
  return run;
}

async function handleCrash(d: BrokerDeps, run: RunRow, e: unknown): Promise<void> {
  const crashes = Number(run.rows_summary["crashes"] ?? 0) + 1;
  d.log("run_crashed", { run: run.id, error: errName(e), crashes });
  const rows_summary = { ...run.rows_summary, crashes };
  if (crashes >= 3) {
    await d.store.patchRun(run.id, {
      state: "failed",
      error_code: -7,
      error_message: flexErrorInfo(-7).message,
      finished_at: iso(d.now()),
      lease_until: null,
      next_poll_at: null,
      rows_summary,
    });
  } else {
    await d.store.patchRun(run.id, {
      lease_until: null,
      next_poll_at: iso(d.now() + 60_000),
      rows_summary,
    });
  }
}

/** Minute tick: claims due runs (leases, SKIP LOCKED in SQL), advances each once, stops at the budget. */
export async function workerTick(d: BrokerDeps, budgetMs: number): Promise<{ processed: number }> {
  const deadline = d.now() + budgetMs;
  let processed = 0;
  while (d.now() < deadline) {
    const runs = await d.store.claimRuns(3, LEASE_SECONDS);
    if (runs.length === 0) break;
    for (const run of runs) {
      processed += 1;
      try {
        await advanceRun(d, run);
      } catch (e) {
        await handleCrash(d, run, e);
      }
    }
  }
  return { processed };
}
