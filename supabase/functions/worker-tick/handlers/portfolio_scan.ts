// Stage 8 `portfolio_scan` (spec 7.4, 8.5, 8.6, 9.7): holding bars and results, valuation tags, premium episodes, risk-monitor set.

import { createRiskSetStore, refreshRiskSet } from "../../_shared/adapters/risk-set.ts";
import { freshnessOf } from "../../_shared/core/calendar.ts";
import { type ActiveEpisode, type Observation, stepPremium } from "../../_shared/core/episodes.ts";
import { type HoldingResult, tagFor } from "../../_shared/core/holding-tag.ts";
import { type Channel, computeChannel } from "../../_shared/core/indicator.ts";
import { chunk } from "../lib/batching.ts";
import { dayOfDate, fetchByIds, loadExchanges, upsertChunks } from "../lib/data.ts";
import {
  DeferError,
  FatalJobError,
  type Handler,
  type HandlerContext,
  type Seeder,
  type SeedPlan,
} from "../types.ts";
import { handleFetchBars } from "./fetch_bars.ts";

// the pure tag mapping lives in the shared core (also used by portfolio-refresh); re-exported for the stage's own tests
export { type HoldingResult, tagFor };
export const HOLDINGS_BATCH = 12;
export const PRIORITY = { holdings: 10, premium: 20, risk_set: 30 } as const;

/** `premium` and `risk_set` are always seeded, so a run without holdings still finishes the stage. */
export function planPortfolioJobs(todo: readonly string[]): SeedPlan {
  const parts = chunk([...todo], HOLDINGS_BATCH);
  return {
    keys: [...parts.map((_, i) => `holdings:${i}`), "premium", "risk_set"],
    payloads: [...parts.map((ids) => ({ securityIds: ids })), {}, {}],
    priorities: [...parts.map(() => PRIORITY.holdings), PRIORITY.premium, PRIORITY.risk_set],
  };
}

/** Held signal securities that the universe scan of this run did not process (those need fetch + compute here). */
export const seedPortfolioScan: Seeder = async (ctx) => {
  const held = await heldSignalSecurities(ctx.db.sb);
  const done = await alreadyScanned(ctx.db.sb, ctx.run.id, held);
  return planPortfolioJobs(held.filter((id) => !done.has(id)));
};

async function alreadyScanned(
  sb: HandlerContext["db"]["sb"],
  runId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk([...ids], 100)) {
    const { data, error } = await sb
      .from("scan_security_results")
      .select("security_id")
      .eq("scan_run_id", runId)
      .eq("scope", "universe")
      .eq("status", "processed")
      .in("security_id", part);
    if (error) throw new FatalJobError(`scan_security_results: ${error.code ?? "error"}`);
    for (const r of (data as Array<{ security_id: string }> | null) ?? []) out.add(r.security_id);
  }
  return out;
}

async function heldSignalSecurities(sb: HandlerContext["db"]["sb"]): Promise<string[]> {
  const { data, error } = await sb.schema("app").rpc("held_signal_securities");
  if (error) throw new FatalJobError(`held_signal_securities: ${error.code ?? "error"}`);
  return ((data as Array<{ security_id: string }> | null) ?? []).map((r) => r.security_id).sort();
}

// ---------------------------------------------------------------------------------------------------- holdings: bars + holding_only results

export interface SeriesInput {
  security_id: string;
  close: number[];
  bar_count: number;
  last_session_date: string;
  completeness: Record<string, unknown>;
  end: Channel["end"] | null;
}

export function buildHoldingRows(a: {
  runId: string;
  length: number;
  nowIso: string;
  securities: Array<{ id: string; quote_type: string; exchange_code: string }>;
  series: SeriesInput[];
  freshness: (lastSessionDate: string, exchangeCode: string) => "fresh" | "stale" | "unavailable";
}): Array<Record<string, unknown>> {
  const byId = new Map(a.series.map((s) => [s.security_id, s]));
  return a.securities.map((sec) => {
    const base = {
      scan_run_id: a.runId,
      security_id: sec.id,
      scope: "holding_only",
      computed_at: a.nowIso,
      tier1_member: false,
    };
    const s = byId.get(sec.id);
    if (s === undefined) return { ...base, status: "failed", reason_codes: ["unprocessed"] };
    const freshness = a.freshness(s.last_session_date, sec.exchange_code);
    const status =
      s.bar_count < a.length ? "insufficient_data" : freshness !== "fresh" ? "stale" : "processed";
    return {
      ...base,
      status,
      reason_codes: [],
      session_date: s.last_session_date,
      close: s.close[s.close.length - 1] ?? null,
      freshness,
      valid_bars: s.bar_count,
      channel: s.end === null ? null : { end: s.end },
    };
  });
}

async function handleHoldings(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const ids = Array.isArray(ctx.job.payload["securityIds"])
    ? (ctx.job.payload["securityIds"] as string[])
    : [];
  // bars: P1's fetch_bars handler works for any security ids in the payload
  const fetched = await handleFetchBars({
    ...ctx,
    job: { ...ctx.job, payload: { securityIds: ids } },
  });

  const securities = await fetchByIds<{ id: string; quote_type: string; exchange_code: string }>(
    sb,
    "securities",
    "id, quote_type, exchange_code",
    "id",
    ids,
  );
  const rows = await fetchByIds<{
    security_id: string;
    close: number[];
    high: number[];
    low: number[];
    bar_count: number;
    last_session_date: string;
    completeness: Record<string, unknown>;
  }>(
    sb,
    "price_series",
    "security_id, close, high, low, bar_count, last_session_date, completeness",
    "security_id",
    ids,
  );
  const settings = ctx.run.settings.indicator;
  const exchanges = await loadExchanges(sb);
  const series: SeriesInput[] = rows.map((r) => {
    const outcome = computeChannel({ close: r.close, high: r.high, low: r.low }, settings);
    return {
      security_id: r.security_id,
      close: r.close,
      bar_count: r.bar_count,
      last_session_date: r.last_session_date,
      completeness: r.completeness,
      end: outcome.ok ? outcome.channel.end : null,
    };
  });
  const out = buildHoldingRows({
    runId: ctx.run.id,
    length: settings.length,
    nowIso: new Date(ctx.run.startedAtMs).toISOString(),
    securities,
    series,
    freshness: (last, exchange) =>
      freshnessOf(dayOfDate(last), ctx.run.scanDay, exchanges.get(exchange)?.max_gap_days ?? 5),
  });
  // (scan_run_id, security_id) is unique: a universe row of this run (written by compute) is never replaced by a holding_only row
  const universe = new Set(
    (
      await fetchByIds<{ security_id: string }>(
        sb,
        "scan_security_results",
        "security_id",
        "security_id",
        ids,
        (q) => q.eq("scan_run_id", ctx.run.id).eq("scope", "universe"),
      )
    ).map((r) => r.security_id),
  );
  const toWrite = out.filter((r) => !universe.has(r["security_id"] as string));
  await upsertChunks(sb, "scan_security_results", toWrite, "scan_run_id,security_id", 100);
  return { requested: ids.length, fetched, written: toWrite.length, universe: universe.size };
}

// ---------------------------------------------------------------------------------------------------- tags

// ---------------------------------------------------------------------------------------------------- premium episodes

export interface PremiumStore {
  active(securityId: string, kind: "premium1" | "premium2"): Promise<ActiveEpisode | null>;
  open(e: {
    runId: string;
    securityId: string;
    companyId: string;
    kind: "premium1" | "premium2";
    line: "+1" | "+2";
    sessionDate: string;
    sessionDay: number;
    close: number;
    lineValue: number;
    notify: boolean;
    reason: string;
  }): Promise<void>;
  close(id: string, runId: string, sessionDate: string, reason: string): Promise<void>;
  touch(id: string, sessionDate: string, sessionDay: number): Promise<void>;
}

export async function applyPremiumEpisodes(
  store: PremiumStore,
  i: {
    runId: string;
    securityId: string;
    companyId: string;
    sessionDate: string;
    close: number;
    end: { upper1: number; upper2: number };
    canOpen: boolean;
  },
): Promise<{ opened: number; closed: number }> {
  const sessionDay = dayOfDate(i.sessionDate);
  let opened = 0;
  let closed = 0;
  for (const [kind, line, lineValue] of [
    ["premium1", "+1", i.end.upper1],
    ["premium2", "+2", i.end.upper2],
  ] as const) {
    const active = await store.active(i.securityId, kind);
    const obs: Observation = {
      sessionDay,
      close: i.close,
      evaluable: i.canOpen,
      lineEnd: lineValue,
      canOpen: i.canOpen,
      rank: null,
      applicableLine: line,
    };
    for (const action of stepPremium(active, obs, kind)) {
      if (action.type === "open") {
        await store.open({
          runId: i.runId,
          securityId: i.securityId,
          companyId: i.companyId,
          kind,
          line,
          sessionDate: i.sessionDate,
          sessionDay,
          close: i.close,
          lineValue,
          notify: action.notify,
          reason: action.reason,
        });
        opened += 1;
      } else if (action.type === "close" && active !== null) {
        await store.close(active.id, i.runId, i.sessionDate, action.reason);
        closed += 1;
      } else if (
        action.type === "noop" &&
        action.reason === "still_above" &&
        active !== null &&
        sessionDay > active.lastEvaluatedSessionDay
      ) {
        await store.touch(active.id, i.sessionDate, sessionDay);
      }
    }
  }
  return { opened, closed };
}

function createPremiumStore(sb: HandlerContext["db"]["sb"]): PremiumStore {
  return {
    async active(securityId, kind) {
      const { data, error } = await sb
        .from("signal_episodes")
        .select("id,kind,mode,threshold_line,opened_session_date,last_evaluated_session_date")
        .eq("security_id", securityId)
        .eq("kind", kind)
        .eq("mode", "worldwide")
        .eq("status", "active")
        .maybeSingle();
      if (error) throw new FatalJobError(`signal_episodes: ${error.code ?? "error"}`);
      const r = data as {
        id: string;
        threshold_line: "+1" | "+2";
        opened_session_date: string;
        last_evaluated_session_date: string;
      } | null;
      return r === null
        ? null
        : {
            id: r.id,
            kind,
            mode: "worldwide",
            line: r.threshold_line,
            openedSessionDay: dayOfDate(r.opened_session_date),
            lastEvaluatedSessionDay: dayOfDate(r.last_evaluated_session_date),
          };
    },
    async open(e) {
      const { error } = await sb.from("signal_episodes").insert({
        security_id: e.securityId,
        company_id: e.companyId,
        kind: e.kind,
        mode: "worldwide",
        threshold_line: e.line,
        status: "active",
        opened_scan_run_id: e.runId,
        opened_session_date: e.sessionDate,
        opened_close: e.close,
        opened_line_value: e.lineValue,
        opened_rank: null,
        open_reason: e.reason,
        notify: e.notify,
        last_evaluated_session_date: e.sessionDate,
      });
      if (error && error.code !== "23505")
        throw new FatalJobError(`signal_episodes.insert: ${error.code ?? "error"}`);
    },
    async close(id, runId, sessionDate, reason) {
      const { error } = await sb
        .from("signal_episodes")
        .update({
          status: "closed",
          closed_scan_run_id: runId,
          closed_session_date: sessionDate,
          close_reason: reason,
          last_evaluated_session_date: sessionDate,
        })
        .eq("id", id);
      if (error) throw new FatalJobError(`signal_episodes.close: ${error.code ?? "error"}`);
    },
    async touch(id, sessionDate) {
      const { error } = await sb
        .from("signal_episodes")
        .update({ last_evaluated_session_date: sessionDate })
        .eq("id", id);
      if (error) throw new FatalJobError(`signal_episodes.touch: ${error.code ?? "error"}`);
    },
  };
}

async function handlePremium(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  // wait until every holdings job of this run is terminal (a dead chunk simply leaves its tags Unavailable)
  const { data: open } = await sb
    .from("scan_jobs")
    .select("id")
    .eq("scan_run_id", ctx.run.id)
    .eq("stage", "portfolio_scan")
    .like("key", "holdings:%")
    .in("status", ["queued", "leased", "failed"])
    .limit(1);
  if (((open as unknown[] | null) ?? []).length > 0) throw new DeferError(20, "holdings_pending");

  const held = await heldSignalSecurities(sb);
  if (held.length === 0) return { held: 0 };
  const secs = await fetchByIds<{ id: string; quote_type: string; company_id: string }>(
    sb,
    "securities",
    "id, quote_type, company_id",
    "id",
    held,
  );
  type ResultRow = {
    security_id: string;
    status: string;
    session_date: string | null;
    close: number | null;
    channel: { end: Channel["end"] } | null;
  };
  const forRun = await sb
    .from("scan_security_results")
    .select("security_id,status,session_date,close,channel")
    .eq("scan_run_id", ctx.run.id)
    .in("security_id", held);
  const current = new Map(
    ((forRun.data as ResultRow[] | null) ?? []).map((r) => [r.security_id, r]),
  );
  const ranks = await sb
    .from("universe_snapshots")
    .select("security_id,rank")
    .eq("scan_run_id", ctx.run.id)
    .eq("mode", "worldwide")
    .in("security_id", held);
  const rankOf = new Map(
    ((ranks.data as Array<{ security_id: string; rank: number }> | null) ?? []).map((r) => [
      r.security_id,
      r.rank,
    ]),
  );

  const premium = createPremiumStore(sb);
  const counts = { tagged: 0, opened: 0, closed: 0 };
  for (const sec of secs) {
    ctx.signal.throwIfAborted();
    const r = current.get(sec.id);
    const holding: HoldingResult | undefined =
      r === undefined
        ? undefined
        : {
            securityId: sec.id,
            status: r.status,
            sessionDate: r.session_date,
            close: r.close,
            channel: r.channel,
            quoteType: sec.quote_type,
            companyId: sec.company_id,
          };
    const t = tagFor(holding, rankOf.get(sec.id) ?? null);
    const { error } = await sb.schema("app").rpc("apply_holding_tag", {
      p_security: sec.id,
      p_tag: t.tag,
      p_session: t.sessionDate,
      p_reason: t.reason,
    });
    if (error) throw new FatalJobError(`apply_holding_tag: ${error.code ?? "error"}`);
    counts.tagged += 1;
    if (
      holding !== undefined &&
      holding.status === "processed" &&
      holding.channel !== null &&
      holding.close !== null &&
      holding.sessionDate !== null &&
      sec.quote_type === "EQUITY"
    ) {
      const e = await applyPremiumEpisodes(premium, {
        runId: ctx.run.id,
        securityId: sec.id,
        companyId: sec.company_id,
        sessionDate: holding.sessionDate,
        close: holding.close,
        end: { upper1: holding.channel.end.upper1, upper2: holding.channel.end.upper2 },
        canOpen: true,
      });
      counts.opened += e.opened;
      counts.closed += e.closed;
    }
  }
  await ctx.log("portfolio_premium", counts);
  return counts;
}

async function handleRiskSet(ctx: HandlerContext): Promise<Record<string, unknown>> {
  return await refreshRiskSet(createRiskSetStore(ctx.db.sb));
}

export const handlePortfolioScan: Handler = async (ctx) => {
  const kind = ctx.job.key.split(":")[0];
  if (kind === "holdings") return await handleHoldings(ctx);
  if (kind === "premium") return await handlePremium(ctx);
  if (kind === "risk_set") return await handleRiskSet(ctx);
  throw new FatalJobError(`unknown portfolio_scan job ${ctx.job.key}`);
};
