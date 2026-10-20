import { corsHeaders, json, readJson } from "@adapters/http.ts";
import { authenticate, type UserVerifier } from "@adapters/user-auth.ts";
import { scanDateLocal } from "@core/calendar.ts";
import { type HoldingResult, tagFor } from "@core/holding-tag.ts";
import {
  buildPortfolioView,
  type HeldPosition,
  neededFxPairs,
  type PortfolioResponse,
  selectLatestSnapshot,
} from "@core/portfolio-view.ts";
import {
  AUTO_REFRESH_MS,
  dailySyncDue,
  expectedStatementDate,
  MANUAL_COOLDOWN_S,
  statementFreshness,
} from "@core/statement-day.ts";
import type { QuoteSource } from "./quotes.ts";

export interface RefreshConnection {
  status: string;
  base_currency: string | null;
  last_statement_date: string | null;
  next_flex_fetch_not_before: string | null;
  last_manual_refresh_at: string | null;
  last_sync_at: string | null;
  coverage_from: string | null;
}

export interface RevalueClaim {
  outcome: "claimed" | "not_found" | "not_screened" | "cooldown";
  signalSecurityId: string | null;
  /** claimed: the stamp + 24 h; cooldown: when the next re-evaluation is allowed */
  nextAllowedAt: string | null;
}

export interface RevalueTag {
  tag: string;
  reason: string;
  sessionDate: string | null;
}

export interface RefreshStore {
  /** the newest scan run with published results (`results_published_at`), null before the first publication */
  latestPublishedRunId(): Promise<string | null>;
  /** ONE atomic UPDATE ... WHERE (app.claim_holding_revalue): 24 h window per holding, stamps valuation_revalued_at */
  claimHoldingRevalue(userId: string, conid: number): Promise<RevalueClaim>;
  /** the security's result row of the run (with its quote type) and its worldwide rank in the run's ranking snapshot */
  loadRevalueInput(
    runId: string,
    securityId: string,
  ): Promise<{ result: HoldingResult | undefined; worldwideRank: number | null }>;
  /** writes tag, session date and reason on the caller's latest-snapshot rows of this conid */
  applyHoldingTag(userId: string, conid: number, t: RevalueTag): Promise<void>;
  getConnection(userId: string): Promise<RefreshConnection | null>;
  /** ONE atomic UPDATE ... WHERE (app.claim_manual_refresh); the handler never checks the cooldown itself */
  claimManualRefresh(userId: string): Promise<{ claimed: boolean; availableAt: string | null }>;
  loadLatestPositions(userId: string): Promise<HeldPosition[]>;
  hasActiveRun(userId: string): Promise<boolean>;
  /** true when a run was created (idempotency key `<user>:daily:<Sofia date>` shared with the cron) */
  /** `statementTo` is the expected statement day (previous weekday), not simply runDate - 1. */
  enqueueDailySync(userId: string, runDate: string, statementTo: string): Promise<boolean>;
}

export interface RefreshDeps {
  verifier: UserVerifier;
  store: RefreshStore;
  quotes: QuoteSource;
  nowMs(): number;
  allowedOrigins?: string[];
  log(event: string, data?: Record<string, unknown>): void;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function handleRequest(req: Request, d: RefreshDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), d.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET" && req.method !== "POST") {
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...cors, allow: "GET, POST, OPTIONS" } },
    );
  }
  try {
    const auth = await authenticate(req, d.verifier, cors);
    if (!auth.ok) return auth.response;
    const userId = auth.userId;

    let manual = false;
    if (req.method === "POST") {
      const body = await readJson(req, 2_000);
      if (!body.ok) return body.response;
      const fields =
        typeof body.value === "object" && body.value !== null
          ? (body.value as Record<string, unknown>)
          : {};
      if (fields["action"] === "revalue") return await revalue(userId, fields["conid"], d, cors);
      manual = fields["manual"] === true;
    }

    const conn = await d.store.getConnection(userId);
    if (conn === null || conn.status === "unlinked" || conn.status === "linking")
      return json({ error: "not_linked" }, { status: 409, headers: cors });

    const now = d.nowMs();
    let manualAvailableMs =
      conn.last_manual_refresh_at === null
        ? now
        : Math.max(now, Date.parse(conn.last_manual_refresh_at) + MANUAL_COOLDOWN_S * 1000);
    if (manual) {
      const claim = await d.store.claimManualRefresh(userId);
      if (!claim.claimed) {
        const retry = Math.max(
          1,
          Math.ceil(
            ((claim.availableAt === null
              ? now + MANUAL_COOLDOWN_S * 1000
              : Date.parse(claim.availableAt)) -
              now) /
              1000,
          ),
        );
        return json(
          { error: "cooldown", retryAfterSeconds: retry },
          { status: 429, headers: { ...cors, "retry-after": String(retry) } },
        );
      }
      manualAvailableMs =
        claim.availableAt === null ? now + MANUAL_COOLDOWN_S * 1000 : Date.parse(claim.availableAt);
    }

    // a new statement day is expected: queue the daily run (best effort, never fails the refresh)
    const expected = expectedStatementDate(now);
    let syncQueued = false;
    try {
      if (
        dailySyncDue({
          lastStatementDate: conn.last_statement_date,
          expected,
          nowMs: now,
          hasActiveRun: await d.store.hasActiveRun(userId),
          nextFetchNotBeforeMs:
            conn.next_flex_fetch_not_before === null
              ? null
              : Date.parse(conn.next_flex_fetch_not_before),
        })
      ) {
        syncQueued = await d.store.enqueueDailySync(userId, scanDateLocal(now), expected);
      }
    } catch (e) {
      d.log("daily_sync_enqueue_failed", { error: e instanceof Error ? e.name : "error" });
    }

    const positions = selectLatestSnapshot(await d.store.loadLatestPositions(userId));
    const base = conn.base_currency ?? "";
    const reportDate = positions[0]?.reportDate ?? conn.last_statement_date;
    const q = await d.quotes.quotes(
      positions.flatMap((p) => (p.valuationSymbol === null ? [] : [p.valuationSymbol])),
    );
    const fx = await d.quotes.fx(neededFxPairs(positions, q.map, base));
    const view = buildPortfolioView({
      nowMs: now,
      baseCurrency: base,
      reportDate,
      lastStatementDate: conn.last_statement_date,
      positions,
      quotes: q.map,
      fx: fx.map,
    });

    const body: PortfolioResponse = {
      serverTime: iso(now),
      nextAutoRefreshAt: iso(now + AUTO_REFRESH_MS),
      manualAvailableAt: iso(manualAvailableMs),
      lastSuccessfulAt: view.quotesFetchedAt,
      baseCurrency: conn.base_currency,
      reportDate,
      lastStatementDate: conn.last_statement_date,
      statement: {
        expectedDate: expected,
        freshness: statementFreshness(conn.last_statement_date ?? reportDate, expected),
      },
      syncQueued,
      quoteError: q.error ?? fx.error,
      view,
    };
    return json(body, { headers: cors });
  } catch (e) {
    d.log("refresh_failed", { error: e instanceof Error ? e.name : "error" });
    return json({ error: "internal_error" }, { status: 500, headers: cors });
  }
}

const fail = (
  status: number,
  reason: string,
  cors: Record<string, string>,
  extra: Record<string, unknown> = {},
): Response => json({ ok: false, reason, ...extra }, { status, headers: cors });

/**
 * Re-evaluates ONE holding of the caller from the latest published scan run, at most once per holding per 24 h. The run is looked
 * up before the claim so a missing run never spends the day's allowance.
 */
async function revalue(
  userId: string,
  conid: unknown,
  d: RefreshDeps,
  cors: Record<string, string>,
): Promise<Response> {
  if (typeof conid !== "number" || !Number.isSafeInteger(conid) || conid <= 0)
    return fail(400, "bad_request", cors);
  const runId = await d.store.latestPublishedRunId();
  if (runId === null) return fail(409, "no_scan", cors);
  const claim = await d.store.claimHoldingRevalue(userId, conid);
  if (claim.outcome === "not_found") return fail(404, "not_found", cors);
  if (claim.outcome === "not_screened" || claim.signalSecurityId === null)
    return fail(409, "not_screened", cors);
  if (claim.outcome === "cooldown")
    return fail(429, "cooldown", cors, { next_allowed_at: claim.nextAllowedAt });
  const input = await d.store.loadRevalueInput(runId, claim.signalSecurityId);
  const t = tagFor(input.result, input.worldwideRank);
  await d.store.applyHoldingTag(userId, conid, t);
  return json(
    {
      ok: true,
      tag: t.tag,
      reason: t.reason,
      session_date: t.sessionDate,
      next_allowed_at: claim.nextAllowedAt,
    },
    { headers: cors },
  );
}
