import { exchangeOfSweepKey } from "../lib/batching.ts";
import {
  computeCoverage,
  listGaps,
  type ResultStatus,
  seededResearchJobs,
} from "../lib/coverage.ts";
import {
  DbQueryError,
  dayOfDate,
  fetchByIds,
  previousMembers,
  selectAll,
  selectCandidates,
} from "../lib/data.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";

/**
 * Stage 8 `publish` (initial): builds the coverage object, makes sure every candidate has a result row (unprocessed securities are never
 * rendered as passing, 7.7) and sets results_published_at and, at >= 95% coverage, list_published_at.
 */
export const seedPublish: Seeder = () =>
  Promise.resolve({ keys: ["publish:initial"], priorities: [100] });

export const handlePublish: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const { run } = ctx;
  const candidates = await selectCandidates(sb, run.id, run.settings.universe.thresholdUsd);
  const results = await selectAll<{ security_id: string; status: ResultStatus }>(
    sb,
    "scan_security_results",
    "security_id, status",
    (q) => q.eq("scan_run_id", run.id),
  );
  const statusOf = new Map(results.map((r) => [r.security_id, r.status]));

  const missing = candidates.filter((c) => !statusOf.has(c.securityId));
  if (missing.length > 0) {
    const { error } = await sb.from("scan_security_results").upsert(
      missing.map((c) => ({
        scan_run_id: run.id,
        security_id: c.securityId,
        scope: "universe",
        status: "unprocessed",
        reason_codes: ["unprocessed"],
        tier1_member: false,
      })),
      { onConflict: "scan_run_id,security_id", ignoreDuplicates: true },
    );
    if (error) throw new DbQueryError("scan_security_results.unprocessed", error.message);
    for (const c of missing)
      await ctx.log(
        "security_skipped",
        { reason: "unprocessed", symbol: c.yahooSymbol },
        { level: "warn", securityId: c.securityId },
      );
  }

  const ids = candidates.map((c) => c.securityId);
  const prices = await fetchByIds<{
    security_id: string;
    freshness: "fresh" | "stale" | "unavailable";
    completeness: { suspect?: boolean };
  }>(sb, "price_series", "security_id, freshness, completeness", "security_id", ids);
  const priceOf = new Map(prices.map((p) => [p.security_id, p]));

  const sweepJobs = await selectAll<{
    key: string;
    status: string;
    result: { rawRows?: number } | null;
  }>(sb, "scan_jobs", "key, status, result", (q) =>
    q.eq("scan_run_id", run.id).eq("stage", "universe_sweep"),
  );
  const failedExchanges = sweepJobs
    .filter((j) => j.status === "dead")
    .map((j) => exchangeOfSweepKey(j.key))
    .filter((c): c is string => c !== null);
  const rawRows = sweepJobs.reduce(
    (sum, j) => sum + (j.status === "done" ? (j.result?.rawRows ?? 0) : 0),
    0,
  );
  const enabled = await selectAll<{ code: string }>(sb, "exchanges", "code", (q) =>
    q.eq("screener_enabled", true),
  );

  const snapshots = await selectAll<{ security_id: string; state: string }>(
    sb,
    "universe_snapshots",
    "security_id, state",
    (q) => q.eq("scan_run_id", run.id).eq("mode", "worldwide"),
  );
  const cards = await selectAll<{ security_id: string }>(
    sb,
    "todays_discounts",
    "security_id",
    (q) => q.eq("scan_run_id", run.id).eq("mode", "worldwide"),
  );
  // research counts only what the run seeded (read from its stage_seeded events), not the cards: those are researched on request
  const seededEvents = await selectAll<{ data: unknown }>(sb, "scan_events", "data", (q) =>
    q.eq("scan_run_id", run.id).eq("event", "stage_seeded"),
  );
  const fxJob = (
    await selectAll<{ result: { rate_date?: string | null; missing?: string[] } | null }>(
      sb,
      "scan_jobs",
      "result",
      (q) => q.eq("scan_run_id", run.id).eq("stage", "fx").eq("status", "done"),
    )
  )[0];
  const rateDate = fxJob?.result?.rate_date ?? null;

  // carried-forward securities and securities of dead exchanges owe a result and count as unprocessed in the list coverage (7.7)
  const exchangeOf = new Map(
    (
      await fetchByIds<{ id: string; exchange_code: string }>(
        sb,
        "securities",
        "id, exchange_code",
        "id",
        ids,
      )
    ).map((s) => [s.id, s.exchange_code]),
  );
  const gaps = listGaps({
    candidates: candidates.map((c) => ({
      securityId: c.securityId,
      exchange: exchangeOf.get(c.securityId) ?? null,
    })),
    carriedIds: new Set(
      snapshots.filter((s) => s.state === "carried_forward").map((s) => s.security_id),
    ),
    previousMembers: await previousMembers(sb, run.scanDateLocal),
    failedExchanges: new Set(failedExchanges),
  });

  const coverage = computeCoverage({
    exchangesTotal: enabled.length,
    failedExchanges,
    rawRows,
    companies: snapshots.filter((s) => s.state === "member").length,
    candidates: candidates.map((c) => ({
      status: statusOf.get(c.securityId) ?? "unprocessed",
      unprocessed: gaps.flagged.has(c.securityId),
    })),
    extraUnprocessed: gaps.extra,
    carriedForward: snapshots.filter((s) => s.state === "carried_forward").length,
    prices: candidates.map((c) => ({
      freshness: priceOf.get(c.securityId)?.freshness ?? "unavailable",
      suspect: priceOf.get(c.securityId)?.completeness.suspect === true,
    })),
    fx: {
      rateDate,
      scanDay: run.scanDay,
      rateDay: rateDate === null ? null : dayOfDate(rateDate),
      missing: fxJob?.result?.missing ?? [],
    },
    research: {
      required: seededResearchJobs(seededEvents),
      cards: new Set(cards.map((c) => c.security_id)).size,
    },
    minListCoverage: run.settings.pipeline.listPublishMinCoverage,
  });

  const now = new Date().toISOString();
  const { error } = await sb
    .from("scan_runs")
    .update({
      coverage,
      results_published_at: now,
      list_published_at: coverage.publish.list ? now : null,
    })
    .eq("id", run.id);
  if (error) throw new DbQueryError("scan_runs.update", error.message);
  if (coverage.fx.stale)
    await ctx.log("fx_stale", { rate_date: coverage.fx.rate_date }, { level: "warn" });
  await ctx.log("scan_published", {
    list: coverage.publish.list,
    list_coverage: coverage.publish.list_coverage,
    candidates: coverage.candidates,
  });
  return {
    list: coverage.publish.list,
    list_coverage: coverage.publish.list_coverage,
    candidates: coverage.candidates.total,
    failed_exchanges: coverage.universe.failed_exchanges,
  };
};
