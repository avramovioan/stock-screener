import { collectScreenerPages } from "../../_shared/adapters/yahoo.ts";
import { parseSweepKey, sweepKey } from "../lib/batching.ts";
import { fetchAll, loadExchanges, loadFxMap } from "../lib/data.ts";
import { applyQuoteRows } from "../lib/quotes.ts";
import {
  DeferError,
  FatalJobError,
  type Handler,
  type HandlerContext,
  type Seeder,
} from "../types.ts";

const MAX_RECHECK_SYMBOLS = 2500; // five quote() calls of 500: about 5 s, well inside one job

/**
 * Stage 2 `universe_sweep` (5.5). One job per screener-enabled exchange (key = exchange code, `<code>@<offset>` for follow-ups) plus one
 * `recheck:0` job that quotes the known canonical securities the sweep did not return, so a removal is explained by a number.
 */
export const seedUniverseSweep: Seeder = async (ctx) => {
  const exchanges = await loadExchanges(ctx.db.sb);
  const codes = [...exchanges.values()]
    .filter((e) => e.screener_enabled)
    .map((e) => e.code)
    .sort();
  return { keys: [...codes, "recheck:0"], priorities: [...codes.map(() => 100), 200] };
};

export const handleUniverseSweep: Handler = (ctx) => {
  const key = parseSweepKey(ctx.job.key);
  if (key.kind === "recheck") return recheck(ctx);
  const payloadOffset =
    typeof ctx.job.payload["offset"] === "number"
      ? (ctx.job.payload["offset"] as number)
      : key.offset;
  return sweepExchange(ctx, key.code, payloadOffset);
};

async function sweepExchange(
  ctx: HandlerContext,
  code: string,
  offset: number,
): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const exchanges = await loadExchanges(sb);
  const exchange = exchanges.get(code);
  if (exchange === undefined) throw new FatalJobError(`unknown_exchange:${code}`);
  const fx = await loadFxMap(sb, ctx.run.scanDateLocal);

  // The screener applies the market-cap operand in each row's OWN currency (spike 3.7). The strongest currency seen on the venue gives the
  // smallest numeric threshold and so the most inclusive query (A-17); the exact USD filter below removes the surplus.
  const rates = exchange.currencies
    .map((c) => fx.get(c)?.usdPerUnit)
    .filter((v): v is number => v !== undefined);
  if (rates.length === 0) throw new Error(`fx_missing_for_exchange:${code}`);
  const { thresholdUsd, safetyMargin } = ctx.run.settings.universe;
  const localMin = (thresholdUsd * safetyMargin) / Math.max(...rates);

  const swept = await collectScreenerPages(ctx.providers.market, {
    exchange: code,
    minMarketCapLocal: localMin,
    startOffset: offset,
    maxPages: ctx.run.settings.pipeline.maxScreenerPagesPerJob,
  });
  const applied = await applyQuoteRows({
    sb,
    runId: ctx.run.id,
    scanDay: ctx.run.scanDay,
    rows: swept.rows,
    source: "yahoo_screener",
    fx,
    thresholdUsd,
    keepBelowThreshold: false,
    knownExchanges: new Set(exchanges.keys()),
  });
  if (applied.skippedUnknownExchange > 0)
    await ctx.log(
      "unknown_exchange_rows",
      { exchange: code, rows: applied.skippedUnknownExchange },
      { level: "warn" },
    );

  if (swept.nextOffset !== null) {
    await ctx.db.seedStage({
      run: ctx.run.id,
      stage: "universe_sweep",
      keys: [sweepKey(code, swept.nextOffset)],
      payloads: [{ offset: swept.nextOffset }],
      priorities: [100],
    });
  }
  return {
    exchange: code,
    offset,
    localMin,
    pages: swept.pages,
    total: swept.total,
    rawRows: swept.rows.length,
    ...applied,
    nextOffset: swept.nextOffset,
  };
}

async function recheck(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const open = await sb
    .from("scan_jobs")
    .select("id", { count: "exact", head: true })
    .eq("scan_run_id", ctx.run.id)
    .eq("stage", "universe_sweep")
    .neq("key", ctx.job.key)
    .in("status", ["queued", "leased", "failed"]);
  if (open.error) throw new Error(`scan_jobs.count: ${open.error.message}`);
  if ((open.count ?? 0) > 0) throw new DeferError(30, "waiting_for_exchange_jobs");

  const known = await fetchAll<{ id: string; yahoo_symbol: string; missing_scans: number }>(
    "securities.known",
    (a, b) =>
      sb
        .from("securities")
        .select("id, yahoo_symbol, missing_scans")
        .eq("is_canonical", true)
        .eq("status", "active")
        .order("id")
        .range(a, b) as unknown as PromiseLike<{
        data: { id: string; yahoo_symbol: string; missing_scans: number }[] | null;
        error: { message: string } | null;
      }>,
  );
  const snaps = await fetchAll<{ security_id: string }>(
    "market_cap_snapshots.run",
    (a, b) =>
      sb
        .from("market_cap_snapshots")
        .select("security_id")
        .eq("scan_run_id", ctx.run.id)
        .order("id")
        .range(a, b) as unknown as PromiseLike<{
        data: { security_id: string }[] | null;
        error: { message: string } | null;
      }>,
  );
  const seen = new Set(snaps.map((s) => s.security_id));
  const unseen = known.filter((k) => !seen.has(k.id)).slice(0, MAX_RECHECK_SYMBOLS);
  if (unseen.length === 0)
    return { known: known.length, unseen: 0, returned: 0, missing: 0, delisted: 0 };

  const exchanges = await loadExchanges(sb);
  const fx = await loadFxMap(sb, ctx.run.scanDateLocal);
  const rows = await ctx.providers.market.quote(unseen.map((u) => u.yahoo_symbol));
  const applied = await applyQuoteRows({
    sb,
    runId: ctx.run.id,
    scanDay: ctx.run.scanDay,
    rows,
    source: "yahoo_quote",
    fx,
    thresholdUsd: ctx.run.settings.universe.thresholdUsd,
    keepBelowThreshold: true,
    knownExchanges: new Set(exchanges.keys()),
  });

  // 5.8: three scans without data make a security delisted; its stored series stays
  const returned = new Set(rows.map((r) => r.symbol));
  let delisted = 0;
  let missing = 0;
  for (const u of unseen.filter((x) => !returned.has(x.yahoo_symbol))) {
    missing += 1;
    const next = u.missing_scans + 1;
    const status = next >= 3 ? "delisted" : "active";
    if (status === "delisted") delisted += 1;
    const { error } = await sb
      .from("securities")
      .update({ missing_scans: next, status })
      .eq("id", u.id);
    if (error) throw new Error(`securities.update: ${error.message}`);
    await ctx.log(
      "security_missing",
      { symbol: u.yahoo_symbol, missing_scans: next, status },
      { level: "warn", securityId: u.id },
    );
  }
  return {
    known: known.length,
    unseen: unseen.length,
    returned: rows.length,
    missing,
    delisted,
    ...applied,
  };
}
