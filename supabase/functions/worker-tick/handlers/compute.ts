import { freshnessOf } from "../../_shared/core/calendar.ts";
import { evaluateTier1, type Tier1Input } from "../../_shared/core/eligibility.ts";
import { computeChannel } from "../../_shared/core/indicator.ts";
import { batchPlan } from "../lib/batching.ts";
import {
  dayOfDate,
  fetchByIds,
  loadExchanges,
  selectCandidates,
  upsertChunks,
} from "../lib/data.ts";
import { hashWindow } from "../lib/series.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";

/** Consecutive scans without price bars after which a listing is skipped instead of failed (mirrors the sweep's 5.8 rule). */
const NO_DATA_SKIP_AFTER = 3;

/** Stage 5 `compute`: one job per 25 candidate securities (A-09), key `compute:<n>`. */
export const seedCompute: Seeder = async (ctx) => {
  const candidates = await selectCandidates(
    ctx.db.sb,
    ctx.run.id,
    ctx.run.settings.universe.thresholdUsd,
  );
  return batchPlan(
    "compute",
    candidates.map((c) => c.securityId),
    ctx.run.settings.pipeline.batch.compute,
    100,
  );
};

interface SecRow {
  id: string;
  yahoo_symbol: string;
  quote_type: string;
  is_canonical: boolean;
  exchange_code: string;
  first_trade_date: string | null;
  no_bars_scans: number;
}
interface BarsRow {
  security_id: string;
  close: number[];
  high: number[];
  low: number[];
  bar_count: number;
  last_session_date: string;
  completeness: { suspect?: boolean };
}
interface SnapRow {
  security_id: string;
  market_cap_native: number | null;
  fx_usd_per_unit: number | null;
  price_time: string | null;
}

/**
 * Reads the stored series, computes the channel with the run's indicator settings, evaluates Tier 1 and writes one
 * scan_security_results row per security (status, reason codes, channel, window hash). A failure of one security never fails the job.
 */
export const handleCompute: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const ids = Array.isArray(ctx.job.payload["securityIds"])
    ? (ctx.job.payload["securityIds"] as string[])
    : [];
  const { indicator } = ctx.run.settings;
  const secs = new Map(
    (
      await fetchByIds<SecRow>(
        sb,
        "securities",
        "id, yahoo_symbol, quote_type, is_canonical, exchange_code, first_trade_date, no_bars_scans",
        "id",
        ids,
      )
    ).map((r) => [r.id, r]),
  );
  const bars = new Map(
    (
      await fetchByIds<BarsRow>(
        sb,
        "price_series",
        "security_id, close, high, low, bar_count, last_session_date, completeness",
        "security_id",
        ids,
      )
    ).map((r) => [r.security_id, r]),
  );
  const snaps = new Map(
    (
      await fetchByIds<SnapRow>(
        sb,
        "market_cap_snapshots",
        "security_id, market_cap_native, fx_usd_per_unit, price_time",
        "security_id",
        ids,
        (q) => q.eq("scan_run_id", ctx.run.id), // Tier 1 reads today's snapshot only, never a previous day's
      )
    ).map((r) => [r.security_id, r]),
  );
  const exchanges = await loadExchanges(sb);

  const rows: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = {
    processed: 0,
    insufficient_data: 0,
    stale: 0,
    failed: 0,
    skipped: 0,
  };
  for (const id of ids) {
    ctx.signal.throwIfAborted();
    const sec = secs.get(id);
    if (sec === undefined) continue;
    const series = bars.get(id);
    const base = {
      scan_run_id: ctx.run.id,
      security_id: id,
      scope: "universe",
      computed_at: new Date().toISOString(),
    };
    if (series === undefined) {
      if (sec.no_bars_scans >= NO_DATA_SKIP_AFTER) {
        rows.push({
          ...base,
          status: "skipped",
          reason_codes: ["no_price_data"],
          tier1_member: false,
        });
        counts["skipped"] = (counts["skipped"] ?? 0) + 1;
        await ctx.log(
          "security_skipped",
          { stage: "compute", reason: "no_price_data", no_bars_scans: sec.no_bars_scans },
          { level: "info", securityId: id },
        );
        continue;
      }
      rows.push({ ...base, status: "failed", reason_codes: ["unprocessed"], tier1_member: false });
      counts["failed"] = (counts["failed"] ?? 0) + 1;
      await ctx.log(
        "security_failed",
        { stage: "compute", reason: "no_price_series" },
        { level: "warn", securityId: id },
      );
      continue;
    }

    const lastDay = dayOfDate(series.last_session_date);
    const maxGap = exchanges.get(sec.exchange_code)?.max_gap_days ?? 5;
    const freshness = freshnessOf(lastDay, ctx.run.scanDay, maxGap);
    const outcome = computeChannel(
      { close: series.close, high: series.high, low: series.low },
      indicator,
    );
    const snap = snaps.get(id);
    const priceMs = snap?.price_time == null ? null : Date.parse(snap.price_time);
    const input: Tier1Input = {
      quoteType: sec.quote_type,
      isCanonical: sec.is_canonical,
      marketCapMajor: snap?.market_cap_native ?? null,
      marketCapAgeDays:
        priceMs === null ? null : ctx.run.scanDay - Math.floor(priceMs / 86_400_000),
      fxUsdPerUnit: snap?.fx_usd_per_unit ?? null,
      firstTradeDay: sec.first_trade_date === null ? null : dayOfDate(sec.first_trade_date),
      dataSessionDay: lastDay,
      validBars: series.bar_count,
      freshness,
      suspect: series.completeness.suspect === true,
      channel: outcome,
      settingsLength: indicator.length,
    };
    const tier1 = evaluateTier1(input);
    const status =
      series.bar_count < indicator.length
        ? "insufficient_data"
        : freshness !== "fresh"
          ? "stale"
          : "processed";
    counts[status] = (counts[status] ?? 0) + 1;
    rows.push({
      ...base,
      status,
      reason_codes: tier1.failed,
      session_date: series.last_session_date,
      close: series.close[series.close.length - 1] ?? null,
      freshness,
      valid_bars: series.bar_count,
      bars_hash: await hashWindow(series, indicator.length),
      channel: outcome.ok ? outcome.channel : null,
      market_cap_usd: tier1.marketCapUsd,
      tier1_member: tier1.member,
    });
  }
  await upsertChunks(sb, "scan_security_results", rows, "scan_run_id,security_id", 100);
  return { requested: ids.length, written: rows.length, ...counts };
};
