import type { CatalogueRow } from "../../_shared/adapters/ibkr-catalogue.ts";
import type { MarketDataProvider, QuoteRecord } from "../../_shared/adapters/providers.ts";
import type { EurExchange, EurStatus } from "../../_shared/core/handoff.ts";
import { normalizeName } from "../../_shared/core/identity.ts";
import type { HandlerContext, SeedContext, SeedPlan } from "../types.ts";
import {
  type Assessment,
  assessCandidate,
  baseTicker,
  type CanonicalSecurity,
  type CatalogueCandidate,
  type FxPair,
  matchBasis,
  probeSymbol,
  type RankedCandidate,
  rankCandidates,
} from "./eur_match.ts";

/**
 * Stage `eur_resolve` (spec 5.7, 7.4 stage 9). Job key `eur:<security_id>`; with nothing to resolve the seeder returns no keys and
 * `app.seed_stage` leaves its `_empty` done marker (P1), so the pipeline moves on. The result is a display and hand-off convenience:
 * nothing here is read by eligibility, ranking, thresholds or any other screening calculation.
 *
 * Soft failure by design: a missing or doubtful EUR line is data (`unverified`, `none`), never a job failure, so the scan status is not
 * degraded by this convenience. Only an open Yahoo breaker or an exhausted request budget propagate (the loop defers those without consuming an attempt).
 */

export interface FxRate {
  usdPerUnit: number;
  rateDate: string;
}

export interface OverrideRow {
  id: string;
  ibkr_exchange_id: EurExchange;
  action: "force" | "block";
  ibkr_conid: number | null;
  ibkr_local_symbol: string | null;
  eur_symbol_yahoo: string | null;
  isin: string | null;
  reason: string;
}

/** A row of public.eur_equivalents as written by `app.replace_eur_equivalents`. */
export interface EurEquivalentRow {
  ibkr_exchange_id: EurExchange;
  ibkr_conid: number | null;
  ibkr_local_symbol: string | null;
  isin: string | null;
  eur_symbol_yahoo: string | null;
  status: EurStatus;
  verification: Record<string, unknown>;
  verified_at: string | null;
}

export interface SettingsPort {
  getSetting(name: string): Promise<unknown | null>;
  setSetting(name: string, value: unknown): Promise<void>;
}

export interface ResolveStore extends SettingsPort {
  loadSecurity(securityId: string): Promise<CanonicalSecurity | null>;
  /** ISINs of broker positions held in any listing of the security's company (Flex, spec 12.7). Empty before P5 data exists. */
  heldIsins(securityId: string): Promise<string[]>;
  activeOverrides(securityId: string): Promise<OverrideRow[]>;
  findCandidates(q: {
    isins: string[];
    baseTicker: string;
    namePrefix: string;
  }): Promise<CatalogueCandidate[]>;
  loadFx(currencies: string[], scanDate: string): Promise<Map<string, FxRate>>;
  /** The rows currently stored for the security (used to keep a verified row when Yahoo could not be reached). */
  currentEquivalents(securityId: string): Promise<EurEquivalentRow[]>;
  replaceEquivalents(securityId: string, rows: EurEquivalentRow[]): Promise<void>;
  setSecurityIsin(securityId: string, isin: string): Promise<void>;
  resolveTargets(runId: string, limit: number): Promise<string[]>;
}

export interface CatalogueStore extends SettingsPort {
  upsertCatalogue(rows: CatalogueRow[]): Promise<void>;
}

export interface EurSettings {
  enabled: boolean;
  requireShares: boolean;
  maxResolvePerRun: number;
}

/** `app_settings.eur_catalogue`: `{ "enabled": true, "require_shares": false, "max_resolve_per_run": 40 }`. Anything invalid keeps the default. */
export function parseEurSettings(raw: unknown): EurSettings {
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const max = r["max_resolve_per_run"];
  return {
    enabled: r["enabled"] !== false,
    requireShares: r["require_shares"] === true,
    maxResolvePerRun:
      typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 200 ? max : 40,
  };
}

const isFatal = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "YahooUnavailableError" ||
    e.name === "BudgetExceededError" ||
    e.name === "AbortError");

export interface ResolveDeps {
  store: Pick<ResolveStore, "heldIsins" | "activeOverrides" | "findCandidates" | "loadFx">;
  market: Pick<MarketDataProvider, "search" | "quote">;
  scanDate: string;
  nowMs: number;
  requireShares: boolean;
}

export interface ResolveOutcome {
  rows: EurEquivalentRow[];
  /** The ISIN to write to securities.isin when it is still unknown: only ever an ISIN that Yahoo confirmed for a verified candidate. */
  isin: string | null;
  /** True when a Yahoo search or quote call failed non-fatally, so the assessments are missing data rather than negative. */
  degraded: boolean;
  summary: {
    result: EurStatus;
    candidates: number;
    verified: number;
    unverified: number;
    rejected: number;
    overrides: number;
  };
}

const firstToken = (name: string): string => normalizeName(name).split(" ")[0] ?? "";

function rowFromAssessment(
  a: Assessment,
  c: CatalogueCandidate,
  probe: QuoteRecord | null,
  nowMs: number,
): EurEquivalentRow {
  return {
    ibkr_exchange_id: c.exchange_id,
    ibkr_conid: c.conid,
    ibkr_local_symbol: c.local_symbol,
    isin: c.isin,
    eur_symbol_yahoo: probe === null ? null : probeSymbol(c.exchange_id, c.local_symbol),
    status: a.outcome === "verified" ? "verified" : "unverified",
    verification: a.verification as unknown as Record<string, unknown>,
    verified_at: a.outcome === "verified" ? new Date(nowMs).toISOString() : null,
  };
}

function noneRow(
  nowMs: number,
  reason: string,
  extra: Record<string, unknown> = {},
): EurEquivalentRow {
  return {
    ibkr_exchange_id: "IBIS", // the preferred slot carries the negative result (one row per security and exchange)
    ibkr_conid: null,
    ibkr_local_symbol: null,
    isin: null,
    eur_symbol_yahoo: null,
    status: "none",
    verification: {
      method: "automatic",
      checked_at: new Date(nowMs).toISOString(),
      reason,
      ...extra,
    },
    verified_at: null,
  };
}

function overrideRow(o: OverrideRow, nowMs: number): EurEquivalentRow {
  return {
    ibkr_exchange_id: o.ibkr_exchange_id,
    ibkr_conid: o.ibkr_conid,
    ibkr_local_symbol: o.ibkr_local_symbol,
    isin: o.isin,
    eur_symbol_yahoo: o.eur_symbol_yahoo,
    status: "verified", // the operator vouches for it; the row says so in its verification
    verification: {
      method: "manual_override",
      override: true,
      checked_at: new Date(nowMs).toISOString(),
      override_id: o.id,
      reason: o.reason,
    },
    verified_at: new Date(nowMs).toISOString(),
  };
}

/** Spec 5.7 steps 1-5 for one canonical security. Pure apart from the injected ports. */
export async function resolveEurEquivalent(
  security: CanonicalSecurity,
  deps: ResolveDeps,
): Promise<ResolveOutcome> {
  const { store, market, nowMs } = deps;
  const overrides = await store.activeOverrides(security.id);
  const held = await store.heldIsins(security.id);
  const knownIsins = [
    ...new Set([security.isin, ...held].filter((v): v is string => v !== null && v !== "")),
  ];

  // 1. candidates
  const found = await store.findCandidates({
    isins: knownIsins,
    baseTicker: baseTicker(security.yahooSymbol),
    namePrefix: firstToken(security.longName ?? security.companyName),
  });
  const matched: RankedCandidate[] = [];
  for (const candidate of found) {
    const match = matchBasis(security, knownIsins, candidate);
    if (match !== null) matched.push({ candidate, match });
  }
  const ranked = rankCandidates(matched, 3);

  const blocked = new Set(
    overrides.filter((o) => o.action === "block").map((o) => o.ibkr_exchange_id),
  );
  const forced = overrides.filter((o) => o.action === "force");
  const autoRanked = ranked.filter(
    (r) =>
      !blocked.has(r.candidate.exchange_id) &&
      !forced.some((f) => f.ibkr_exchange_id === r.candidate.exchange_id),
  );

  let degraded = false;
  const assessed: { item: RankedCandidate; probe: QuoteRecord | null; assessment: Assessment }[] =
    [];
  if (autoRanked.length > 0) {
    // 2. ISIN confirmation: one search per distinct ISIN
    const isinResults = new Map<string, { primarySymbol: string | null } | "unavailable">();
    for (const { candidate } of autoRanked) {
      if (candidate.isin === null || isinResults.has(candidate.isin)) continue;
      try {
        const r = await market.search(candidate.isin, { quotesCount: 3, newsCount: 0 });
        isinResults.set(candidate.isin, { primarySymbol: r.hits[0]?.symbol ?? null });
      } catch (e) {
        if (isFatal(e)) throw e;
        degraded = true;
        isinResults.set(candidate.isin, "unavailable");
      }
    }
    // 3. one quote() call for the canonical line and every probe
    const symbols = [
      ...new Set([
        security.yahooSymbol,
        ...autoRanked.map((r) => probeSymbol(r.candidate.exchange_id, r.candidate.local_symbol)),
      ]),
    ];
    const quotes = new Map<string, QuoteRecord>();
    try {
      for (const q of await market.quote(symbols)) quotes.set(q.symbol.toUpperCase(), q);
    } catch (e) {
      if (isFatal(e)) throw e;
      degraded = true;
    }
    const rates = await store.loadFx(["EUR", security.currencyMajor], deps.scanDate);
    const eur = rates.get("EUR");
    const fx: FxPair = {
      eurUsd: eur?.usdPerUnit ?? null,
      ccyUsd:
        security.currencyMajor === "USD"
          ? 1
          : (rates.get(security.currencyMajor)?.usdPerUnit ?? null),
      rateDate: eur?.rateDate ?? null,
    };
    const securityQuote = quotes.get(security.yahooSymbol.toUpperCase()) ?? null;
    for (const item of autoRanked) {
      const probe =
        quotes.get(probeSymbol(item.candidate.exchange_id, item.candidate.local_symbol)) ?? null;
      const assessment = assessCandidate({
        security,
        securityQuote,
        candidate: item.candidate,
        match: item.match,
        knownIsins,
        isinSearch:
          item.candidate.isin === null
            ? "unavailable"
            : (isinResults.get(item.candidate.isin) ?? "unavailable"),
        probe,
        fx,
        requireShares: deps.requireShares,
        nowMs,
      });
      assessed.push({ item, probe, assessment });
    }
  }

  // 4-5. status per exchange: verified before unverified; a rejected candidate is not stored; IBIS is preferred by pickListing at read time
  const rows: EurEquivalentRow[] = [];
  let isinToStore: string | null = null;
  for (const exchange of ["IBIS", "AEB"] as const) {
    const force = forced.find((f) => f.ibkr_exchange_id === exchange);
    if (force !== undefined) {
      rows.push(overrideRow(force, nowMs));
      continue;
    }
    const usable = assessed.filter(
      (a) => a.item.candidate.exchange_id === exchange && a.assessment.outcome !== "rejected",
    );
    const best = usable.find((a) => a.assessment.outcome === "verified") ?? usable[0];
    if (best === undefined) continue;
    rows.push(rowFromAssessment(best.assessment, best.item.candidate, best.probe, nowMs));
    if (best.assessment.outcome === "verified" && security.isin === null && isinToStore === null)
      isinToStore = best.item.candidate.isin;
  }
  if (rows.length === 0) {
    const rejected = assessed.map((a) => ({
      exchange: a.item.candidate.exchange_id,
      local_symbol: a.item.candidate.local_symbol,
      conid: a.item.candidate.conid,
      hard_failed: a.assessment.verification.hard_failed,
    }));
    const reason =
      ranked.length === 0
        ? "no_catalogue_candidate"
        : assessed.length === 0
          ? "blocked_by_override"
          : "all_candidates_rejected";
    rows.push(noneRow(nowMs, reason, { candidates: ranked.length, rejected }));
  }

  const count = (o: Assessment["outcome"]): number =>
    assessed.filter((a) => a.assessment.outcome === o).length;
  const result: EurStatus = rows.some((r) => r.status === "verified")
    ? "verified"
    : rows.some((r) => r.status === "unverified")
      ? "unverified"
      : "none";
  return {
    rows,
    isin: isinToStore,
    degraded,
    summary: {
      result,
      candidates: ranked.length,
      verified: count("verified"),
      unverified: count("unverified"),
      rejected: count("rejected"),
      overrides: overrides.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------- handler and seeder

export interface EurResolveCtx {
  job: Pick<HandlerContext["job"], "key">;
  run: Pick<HandlerContext["run"], "scanDateLocal" | "startedAtMs">;
  signal: AbortSignal;
  log: HandlerContext["log"];
}

export async function runEurResolve(
  ctx: EurResolveCtx,
  deps: { store: ResolveStore; market: Pick<MarketDataProvider, "search" | "quote"> },
): Promise<Record<string, unknown>> {
  if (!ctx.job.key.startsWith("eur:")) return { status: "noop" };
  const securityId = ctx.job.key.slice("eur:".length);
  const settings = parseEurSettings(await deps.store.getSetting("eur_catalogue"));
  const security = await deps.store.loadSecurity(securityId);
  if (security === null) {
    await ctx.log(
      "eur_resolve_skipped",
      { reason: "security_not_found" },
      { level: "warn", securityId },
    );
    return { status: "skipped", reason: "security_not_found" };
  }
  ctx.signal.throwIfAborted();
  const outcome = await resolveEurEquivalent(security, {
    store: deps.store,
    market: deps.market,
    scanDate: ctx.run.scanDateLocal,
    nowMs: ctx.run.startedAtMs,
    requireShares: settings.requireShares,
  });
  let rows = outcome.rows;
  if (outcome.degraded) {
    // a failed Yahoo call says nothing about the listing: never overwrite a verified row with a weaker one
    const verified = (await deps.store.currentEquivalents(securityId)).filter(
      (r) => r.status === "verified",
    );
    const kept = new Map(verified.map((r) => [r.ibkr_exchange_id, r]));
    rows = rows.map((r) => (r.status === "verified" ? r : (kept.get(r.ibkr_exchange_id) ?? r)));
    for (const [id, r] of kept) if (!rows.some((x) => x.ibkr_exchange_id === id)) rows.push(r);
  }
  await deps.store.replaceEquivalents(securityId, rows);
  if (outcome.isin !== null) await deps.store.setSecurityIsin(securityId, outcome.isin);
  await ctx.log(
    "eur_resolved",
    { ...outcome.summary, exchanges: rows.map((r) => `${r.ibkr_exchange_id}:${r.status}`) },
    { securityId },
  );
  return { status: "resolved", ...outcome.summary };
}

/** One job per target, at most `max_resolve_per_run`; no targets gives an empty plan. */
export async function seedEurResolve(
  ctx: Pick<SeedContext, "run">,
  store: Pick<ResolveStore, "getSetting" | "resolveTargets">,
): Promise<SeedPlan> {
  const settings = parseEurSettings(await store.getSetting("eur_catalogue"));
  const ids = await store.resolveTargets(ctx.run.id, settings.maxResolvePerRun);
  if (ids.length === 0) return { keys: [] };
  return {
    keys: ids.map((id) => `eur:${id}`),
    payloads: ids.map((id) => ({ securityId: id })),
    priorities: ids.map(() => 150),
  };
}
