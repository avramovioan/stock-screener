import { type ChartMeta, cleanBars } from "../../_shared/core/bars.ts";
import { isoDate, subtractYears } from "../../_shared/core/calendar.ts";
import {
  applyForceCanonical,
  chooseCanonical,
  DEFAULT_SWITCH_RATIO,
  groupListings,
  type ListingFact,
  normalizeName,
} from "../../_shared/core/identity.ts";
import { instrumentRejection } from "../../_shared/core/instruments.ts";
import { batchPlan, chunk } from "../lib/batching.ts";
import { DbQueryError, fetchByIds, loadFxMap } from "../lib/data.ts";
import { type IdentityData, loadIdentityData } from "../lib/identity-data.ts";
import { applyQuoteRows } from "../lib/quotes.ts";
import { averageUsdVolume } from "../lib/volume.ts";
import {
  DeferError,
  type Handler,
  type HandlerContext,
  type Seeder,
  type SeedPlan,
} from "../types.ts";

const PROFILE_MAX_AGE_MS = 30 * 86_400_000; // A-35
const PROBE_MAX_AGE_MS = 7 * 86_400_000; // A-35
const OPEN = ["queued", "leased", "failed"];

/** A common share on a real line: not a bond, ETF, bond-like name or London IOB line (A-50). Only these get profile, enrich or probe calls. */
const isShareListing = (l: ListingFact): boolean =>
  instrumentRejection({
    symbol: l.symbol,
    quoteType: l.quoteType ?? "EQUITY",
    name: l.longName,
  }) === null;

/**
 * Stage 3 `identity`. Jobs (all in this stage): `quote-enrich:<n>` (500 symbols), `profile:<n>` (25 companies), `volume_probe:<n>`
 * (12 securities), and `group:0`, which runs last and applies the pure grouping and canonical choice of core/identity.ts (5.6).
 */
export const seedIdentity: Seeder = async (ctx) => {
  const data = await loadIdentityData(ctx.db.sb, ctx.run.id);
  const pipeline = ctx.run.settings.pipeline;
  const { groups } = groupListings(data.listings, data.overrides);

  const shareIds = new Set(data.listings.filter(isShareListing).map((l) => l.securityId));
  const enrich = [...data.securities.values()]
    .filter(
      (s) =>
        shareIds.has(s.id) &&
        ((data.quality.get(s.id) ?? "ok") !== "ok" ||
          s.shares_outstanding === null ||
          s.first_trade_date === null),
    )
    .map((s) => s.id)
    .sort();

  const profile: string[] = [];
  const probe: string[] = [];
  for (const full of groups) {
    const group = full.filter((l) => shareIds.has(l.securityId));
    if (group.length === 0) continue;
    const primaries = group.filter((l) => l.venueClass === "primary");
    const pool = primaries.length > 0 ? primaries : group;
    const rep = [...pool].sort(
      (a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) || (a.symbol < b.symbol ? -1 : 1),
    )[0] as ListingFact;
    const company = data.companies.get(
      (data.securities.get(rep.securityId) as { company_id: string }).company_id,
    );
    const refreshed =
      company?.profile_refreshed_at === null || company?.profile_refreshed_at === undefined
        ? null
        : Date.parse(company.profile_refreshed_at);
    if (
      company !== undefined &&
      // an unknown country is retried every scan: the home listing cannot be chosen without it (A-50)
      (refreshed === null ||
        company.country === null ||
        ctx.run.startedAtMs - refreshed > PROFILE_MAX_AGE_MS)
    )
      profile.push(rep.securityId);

    const hasCanonical = group.some(
      (l) => data.securities.get(l.securityId)?.is_canonical === true,
    );
    if (primaries.length >= 2 || (!hasCanonical && primaries.length > 0)) {
      for (const l of primaries) {
        const probedAt = data.securities.get(l.securityId)?.volume_probe_at ?? null;
        if (probedAt === null || ctx.run.startedAtMs - Date.parse(probedAt) > PROBE_MAX_AGE_MS)
          probe.push(l.securityId);
      }
    }
  }

  const plans: SeedPlan[] = [
    batchPlan("quote-enrich", enrich, pipeline.batch.quoteBatch, 100),
    batchPlan("profile", profile.sort(), pipeline.batch.profile, 110),
    batchPlan("volume_probe", probe.sort(), pipeline.batch.volumeProbe, 120),
    { keys: ["group:0"], payloads: [{}], priorities: [200] },
  ];
  return {
    keys: plans.flatMap((p) => p.keys),
    payloads: plans.flatMap((p) => p.payloads ?? p.keys.map(() => ({}))),
    priorities: plans.flatMap((p) => p.priorities ?? p.keys.map(() => 100)),
  };
};

export const handleIdentity: Handler = (ctx) => {
  const kind = ctx.job.key.split(":")[0];
  switch (kind) {
    case "quote-enrich":
      return quoteEnrich(ctx);
    case "profile":
      return profileJob(ctx);
    case "volume_probe":
      return volumeProbe(ctx);
    case "group":
      return groupJob(ctx);
    default:
      throw new Error(`unknown identity job ${ctx.job.key}`);
  }
};

const idsOf = (ctx: HandlerContext): string[] =>
  Array.isArray(ctx.job.payload["securityIds"]) ? (ctx.job.payload["securityIds"] as string[]) : [];

async function quoteEnrich(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const secs = await fetchByIds<{ yahoo_symbol: string }>(
    sb,
    "securities",
    "yahoo_symbol",
    "id",
    idsOf(ctx),
  );
  const exchanges = (await loadIdentityData(sb, ctx.run.id)).exchanges;
  const rows = await ctx.providers.market.quote(secs.map((s) => s.yahoo_symbol));
  const applied = await applyQuoteRows({
    sb,
    runId: ctx.run.id,
    scanDay: ctx.run.scanDay,
    rows,
    source: "yahoo_quote",
    fx: await loadFxMap(sb, ctx.run.scanDateLocal),
    thresholdUsd: ctx.run.settings.universe.thresholdUsd,
    keepBelowThreshold: true,
    knownExchanges: new Set(exchanges.keys()),
  });
  return { requested: secs.length, returned: rows.length, ...applied };
}

async function profileJob(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const secs = await fetchByIds<{ id: string; company_id: string; yahoo_symbol: string }>(
    sb,
    "securities",
    "id, company_id, yahoo_symbol",
    "id",
    idsOf(ctx),
  );
  let updated = 0;
  let failed = 0;
  for (const s of secs) {
    ctx.signal.throwIfAborted();
    try {
      const p = await ctx.providers.market.profile(s.yahoo_symbol);
      const { error } = await sb
        .from("companies")
        .update({
          country: p.country,
          sector: p.sector,
          industry: p.industry,
          profile_refreshed_at: new Date(ctx.run.startedAtMs).toISOString(),
        })
        .eq("id", s.company_id);
      if (error) throw new DbQueryError("companies.update", error.message);
      updated += 1;
    } catch (e) {
      if (e instanceof DbQueryError || (e instanceof Error && e.name === "YahooUnavailableError"))
        throw e;
      failed += 1;
      await ctx.log(
        "security_failed",
        { stage: "profile", reason: e instanceof Error ? e.name : "error" },
        { level: "warn", securityId: s.id },
      );
    }
  }
  return { requested: secs.length, updated, failed };
}

async function volumeProbe(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const secs = await fetchByIds<{
    id: string;
    yahoo_symbol: string;
    currency_major: string;
    minor_divisor: number;
  }>(sb, "securities", "id, yahoo_symbol, currency_major, minor_divisor", "id", idsOf(ctx));
  const fx = await loadFxMap(sb, ctx.run.scanDateLocal);
  let probed = 0;
  let failed = 0;
  for (const s of secs) {
    ctx.signal.throwIfAborted();
    const rate = fx.get(s.currency_major);
    if (rate === undefined) {
      failed += 1;
      await ctx.log(
        "security_failed",
        { stage: "volume_probe", reason: "fx_missing", currency: s.currency_major },
        { level: "warn", securityId: s.id },
      );
      continue;
    }
    try {
      const chart = await ctx.providers.market.chart(s.yahoo_symbol, {
        period1: isoDate(ctx.run.scanDay - 60),
        interval: "1d",
        events: "split",
      });
      const meta: ChartMeta = {
        exchangeTimezoneName: chart.meta.exchangeTimezoneName,
        regularMarketTime: chart.meta.regularMarketTime,
        currentTradingPeriod: chart.meta.currentTradingPeriod,
      };
      const { series } = cleanBars(chart.bars, meta, ctx.run.startedAtMs);
      const avg = averageUsdVolume(series, s.minor_divisor, rate.usdPerUnit);
      if (avg === null) throw new Error("no_bars");
      const { error } = await sb
        .from("securities")
        .update({
          avg_usd_volume_30d: avg,
          volume_probe_at: new Date(ctx.run.startedAtMs).toISOString(),
        })
        .eq("id", s.id);
      if (error) throw new DbQueryError("securities.update", error.message);
      probed += 1;
    } catch (e) {
      if (e instanceof DbQueryError || (e instanceof Error && e.name === "YahooUnavailableError"))
        throw e;
      failed += 1;
      await ctx.log(
        "security_failed",
        { stage: "volume_probe", reason: e instanceof Error ? e.message : "error" },
        { level: "warn", securityId: s.id },
      );
    }
  }
  return { requested: secs.length, probed, failed };
}

/** Applies grouping, canonical choice and roles. Runs after every other identity job of the run. */
async function groupJob(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const siblings = await sb
    .from("scan_jobs")
    .select("id", { count: "exact", head: true })
    .eq("scan_run_id", ctx.run.id)
    .eq("stage", "identity")
    .neq("key", ctx.job.key)
    .in("status", OPEN);
  if (siblings.error) throw new Error(`scan_jobs.count: ${siblings.error.message}`);
  if ((siblings.count ?? 0) > 0) throw new DeferError(20, "waiting_for_identity_jobs");

  const data = await loadIdentityData(sb, ctx.run.id);
  const { groups, needsReview } = groupListings(data.listings, data.overrides);
  const { indicator, universe } = ctx.run.settings;
  const cutoff = subtractYears(ctx.run.scanDay, universe.minHistoryYears);
  const eligible = (l: ListingFact) =>
    l.firstTradeDay !== null &&
    l.firstTradeDay <= cutoff &&
    (data.barCounts.get(l.securityId) ?? 0) >= indicator.length;

  const payload: Array<Record<string, unknown>> = [];
  const claims: Array<{ symbols: string[]; hasCurrent: boolean }> = [];
  let switched = 0;
  let blocked = 0;
  let unverified = 0;
  let noPrimary = 0;
  const excluded: Record<string, number> = {};
  const excludedSample: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const members = group
      .map((l) => data.securities.get(l.securityId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    const current = members.find((s) => s.is_canonical);
    // the surviving company: the one that already holds the canonical listing, else the smallest id
    const companyIds = [...new Set(members.map((m) => m.company_id))].sort();
    const target = current?.company_id ?? (companyIds[0] as string);
    const country =
      [target, ...companyIds]
        .map((id) => data.companies.get(id)?.country ?? null)
        .find((c) => c !== null) ?? null;

    let result = chooseCanonical(
      group,
      country,
      current === undefined ? null : { securityId: current.id },
      { switchRatio: DEFAULT_SWITCH_RATIO, isHistoryEligible: eligible },
    );
    result = applyForceCanonical(group, result, data.overrides);
    if (result.flags.includes("canonical_switched")) switched += 1;
    if (result.flags.includes("canonical_switch_blocked")) blocked += 1;
    if (result.flags.includes("canonical_unverified")) unverified += 1;
    if (result.flags.includes("no_primary_listing")) noPrimary += 1;
    if (result.exclusion !== null) {
      excluded[result.exclusion] = (excluded[result.exclusion] ?? 0) + 1;
      if (excludedSample.length < 50)
        excludedSample.push({
          reason: result.exclusion,
          country,
          symbols: group.map((l) => l.symbol),
        });
    }

    const canonicalListing = group.find((l) => l.securityId === result.canonicalId);
    const name =
      canonicalListing?.longName ??
      group.find((l) => l.longName !== null)?.longName ??
      (group[0] as ListingFact).symbol;
    payload.push({
      company_id: target,
      member_ids: group.map((l) => l.securityId),
      canonical_id: result.canonicalId,
      roles: result.roles,
      country,
      name,
      name_normalized: normalizeName(name),
      exclusion_reason: result.exclusion,
    });
    claims.push({ symbols: group.map((l) => l.symbol), hasCurrent: current !== undefined });
    if (result.canonicalId !== null && current !== undefined && result.canonicalId !== current.id) {
      await ctx.log(
        "canonical_changed",
        { symbol: canonicalListing?.symbol, from: current.yahoo_symbol, flags: result.flags },
        { securityId: result.canonicalId },
      );
    }
  }

  // Two groups can resolve to one company when the grouper keeps listings of it apart (cap_mismatch, shares_only). The group
  // holding the company's current canonical keeps the id, else the first group; the others get a fresh company.
  const claimed = new Map<string, number[]>();
  payload.forEach((p, i) => {
    const id = p["company_id"] as string;
    claimed.set(id, [...(claimed.get(id) ?? []), i]);
  });
  for (const [companyId, indexes] of claimed) {
    if (indexes.length < 2) continue;
    const keeper = indexes.find((i) => claims[i]?.hasCurrent) ?? (indexes[0] as number);
    for (const i of indexes) {
      if (i === keeper) continue;
      (payload[i] as Record<string, unknown>)["company_id"] = crypto.randomUUID();
      await ctx.log(
        "company_split",
        {
          company_id: companyId,
          kept: claims[keeper]?.symbols,
          split: claims[i]?.symbols,
        },
        { level: "warn" },
      );
    }
  }

  let merged = 0;
  let deleted = 0;
  let deactivated = 0;
  let displaced = 0;
  for (const part of chunk(payload, 100)) {
    const { data: res, error } = await sb
      .schema("app")
      .rpc("apply_identity_groups", { p_groups: part });
    if (error) throw new DbQueryError("apply_identity_groups", error.message);
    const r = res as {
      orphans_deleted: number;
      orphans_deactivated: number;
      canonical_displaced?: number;
    };
    deleted += r.orphans_deleted;
    deactivated += r.orphans_deactivated;
    displaced += r.canonical_displaced ?? 0;
  }
  if (displaced > 0) await ctx.log("canonical_displaced", { count: displaced }, { level: "warn" });
  merged = groups.filter((g) => g.length > 1).length;
  if (Object.keys(excluded).length > 0)
    await ctx.log("companies_excluded", { counts: excluded, sample: excludedSample });
  if (needsReview.length > 0)
    await ctx.log(
      "identity_needs_review",
      { pairs: needsReview.slice(0, 50), total: needsReview.length },
      { level: "warn" },
    );
  return {
    groups: groups.length,
    merged,
    switched,
    blocked,
    unverified,
    noPrimary,
    excluded,
    needsReview: needsReview.length,
    orphansDeleted: deleted,
    orphansDeactivated: deactivated,
    canonicalDisplaced: displaced,
  };
}

export type { IdentityData };
