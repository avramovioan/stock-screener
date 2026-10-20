import { BudgetExceededError, YahooUnavailableError } from "../../_shared/adapters/throttle.ts";
import { YahooSchemaError } from "../../_shared/adapters/yahoo.ts";
import {
  type ChartMeta,
  cleanBars,
  mergeIncremental,
  type Series,
  seriesStats,
  takeLatest,
} from "../../_shared/core/bars.ts";
import { freshnessOf, isoDate, subtractYears } from "../../_shared/core/calendar.ts";
import { batchPlan } from "../lib/batching.ts";
import {
  DbQueryError,
  dayOfDate,
  fetchByIds,
  isoOfMs,
  loadExchanges,
  selectCandidates,
} from "../lib/data.ts";
import { type PriceSeriesRow, rowFromSeries, sameSeries, seriesFromRow } from "../lib/series.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";

const BACKFILL_YEARS = 13; // 5.2: scanDate - 13 years
const INCREMENTAL_OVERLAP_DAYS = 10; // refetch the last ten calendar days; mergeIncremental compares the overlap

/** Stage 4 `fetch_bars`: one job per 12 candidate securities (A-09), key `bars:<n>`; drift follow-ups are `backfill:<security id>`. */
export const seedFetchBars: Seeder = async (ctx) => {
  const candidates = await selectCandidates(
    ctx.db.sb,
    ctx.run.id,
    ctx.run.settings.universe.thresholdUsd,
  );
  return batchPlan(
    "bars",
    candidates.map((c) => c.securityId),
    ctx.run.settings.pipeline.batch.fetchBars,
    100,
  );
};

interface SecRow {
  id: string;
  yahoo_symbol: string;
  exchange_code: string;
  missing_scans: number;
  no_bars_scans: number;
}

/** Errors that end the whole job (retry / defer) instead of failing a single security. */
const isJobLevel = (e: unknown): boolean =>
  e instanceof YahooUnavailableError ||
  e instanceof BudgetExceededError ||
  e instanceof DbQueryError ||
  (e instanceof DOMException && e.name === "AbortError");

export const handleFetchBars: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const ids = Array.isArray(ctx.job.payload["securityIds"])
    ? (ctx.job.payload["securityIds"] as string[])
    : [];
  const forceBackfill = ctx.job.payload["mode"] === "backfill";
  const nowIso = isoOfMs(ctx.run.startedAtMs);

  const secs = await fetchByIds<SecRow>(
    sb,
    "securities",
    "id, yahoo_symbol, exchange_code, missing_scans, no_bars_scans",
    "id",
    ids,
  );
  const exchanges = await loadExchanges(sb);
  const stored = new Map(
    (
      await fetchByIds<PriceSeriesRow>(
        sb,
        "price_series",
        "security_id, bar_dates, open, high, low, close, volume, bar_count, last_session_date, last_full_refresh_at, completeness",
        "security_id",
        ids,
      )
    ).map((r) => [r.security_id, r]),
  );

  // marketState cross-check (4.3.1): one quote() per job of 12
  const states = new Map<string, string>();
  try {
    for (const q of await ctx.providers.market.quote(secs.map((s) => s.yahoo_symbol)))
      if (q.marketState !== null) states.set(q.symbol, q.marketState);
  } catch (e) {
    // a malformed quote response is a retryable provider failure, never "no market state"
    if (isJobLevel(e) || e instanceof YahooSchemaError) throw e;
  }

  const result = { requested: secs.length, written: 0, unchanged: 0, drift: 0, failed: 0 };
  for (const sec of secs) {
    ctx.signal.throwIfAborted();
    const ex = exchanges.get(sec.exchange_code);
    if (ex === undefined) {
      result.failed += 1;
      await ctx.log(
        "security_failed",
        { stage: "fetch_bars", reason: "unknown_exchange" },
        { level: "warn", securityId: sec.id },
      );
      continue;
    }
    const row = stored.get(sec.id);
    const mode: "backfill" | "incremental" =
      forceBackfill || row === undefined ? "backfill" : "incremental";
    try {
      const period1 =
        mode === "backfill"
          ? isoDate(subtractYears(ctx.run.scanDay, BACKFILL_YEARS))
          : isoDate(
              dayOfDate((row as PriceSeriesRow).last_session_date) - INCREMENTAL_OVERLAP_DAYS,
            );
      const chart = await ctx.providers.market.chart(sec.yahoo_symbol, {
        period1,
        interval: "1d",
        events: "split",
      });
      const state = states.get(sec.yahoo_symbol);
      const meta: ChartMeta = {
        exchangeTimezoneName: chart.meta.exchangeTimezoneName,
        regularMarketTime: chart.meta.regularMarketTime,
        currentTradingPeriod: chart.meta.currentTradingPeriod,
        sessionCloseLocal:
          ex.session_close_local === null ? null : ex.session_close_local.slice(0, 5),
        ...(state === undefined ? {} : { marketState: state }),
      };
      const { series: fetched, report } = cleanBars(chart.bars, meta, ctx.run.startedAtMs);
      if (fetched.dates.length === 0) throw new Error("no_bars");

      let final: Series = fetched;
      let lastFullRefresh = nowIso;
      if (mode === "incremental" && row !== undefined) {
        const newerSplit = chart.splits.some(
          (s) => s.dateMs > Date.parse(row.last_full_refresh_at),
        );
        const merged = mergeIncremental(seriesFromRow(row), fetched, { newerSplit });
        if (merged.adjustmentDrift) {
          // a split rewrote history (or adjustment cannot be proven): nothing is written, a full backfill job follows
          result.drift += 1;
          await ctx.log(
            "bars_adjustment_drift",
            {
              reason: merged.reason,
              maxRelDiff: merged.maxRelDiff,
              overlapBars: merged.overlapBars,
            },
            { level: "warn", securityId: sec.id },
          );
          await ctx.db.seedStage({
            run: ctx.run.id,
            stage: "fetch_bars",
            keys: [`backfill:${sec.id}`],
            payloads: [{ securityIds: [sec.id], mode: "backfill" }],
            priorities: [90],
          });
          continue;
        }
        final = merged.series;
        lastFullRefresh = row.last_full_refresh_at;
      }
      final = takeLatest(final, ctx.run.settings.pipeline.maxStoredBars);

      const stats = seriesStats(final);
      const freshness = freshnessOf(
        final.dates[final.dates.length - 1] ?? null,
        ctx.run.scanDay,
        ex.max_gap_days,
      );
      const completeness = {
        validBars: final.dates.length,
        droppedNullClose: report.droppedNullClose,
        droppedNullHighLow: report.droppedNullHighLow,
        droppedNonPositive: report.droppedNonPositive,
        droppedDuplicates: report.droppedDuplicates,
        droppedForming: report.droppedForming,
        ohlcInconsistent: stats.ohlcInconsistent,
        jumpAnomalies: stats.jumpAnomalies,
        missingSessionRatio: stats.missingSessionRatio,
        suspect: stats.suspect,
        lastFetchMode: mode,
      };

      if (mode === "incremental" && row !== undefined && sameSeries(seriesFromRow(row), final)) {
        // nothing new (weekend, holiday): do not rewrite the TOASTed arrays, only refresh the cheap columns
        const { error } = await sb
          .from("price_series")
          .update({ retrieved_at: nowIso, freshness, completeness })
          .eq("security_id", sec.id);
        if (error) throw new DbQueryError("price_series.update", error.message);
        result.unchanged += 1;
      } else {
        const { error } = await sb.from("price_series").upsert(
          rowFromSeries({
            securityId: sec.id,
            series: final,
            completeness,
            freshness,
            nowIso,
            lastFullRefreshIso: lastFullRefresh,
          }),
          { onConflict: "security_id" },
        );
        if (error) throw new DbQueryError("price_series.upsert", error.message);
        result.written += 1;
      }
      if (sec.missing_scans > 0 || sec.no_bars_scans > 0)
        await sb.from("securities").update({ missing_scans: 0, no_bars_scans: 0 }).eq("id", sec.id);
    } catch (e) {
      if (isJobLevel(e)) throw e;
      result.failed += 1;
      const isNoBars = e instanceof Error && e.message === "no_bars";
      const noBarsScans = isNoBars ? sec.no_bars_scans + 1 : sec.no_bars_scans;
      await ctx.log(
        "security_failed",
        {
          stage: "fetch_bars",
          reason: e instanceof Error ? e.message.slice(0, 120) : "error",
          mode,
          no_bars_scans: noBarsScans,
        },
        { level: "warn", securityId: sec.id },
      );
      await sb
        .from("securities")
        .update({
          missing_scans: sec.missing_scans + 1,
          ...(isNoBars ? { no_bars_scans: noBarsScans } : {}),
        })
        .eq("id", sec.id);
    }
  }
  return result;
};
