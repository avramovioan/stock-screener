import type { SupabaseClient } from "@supabase/supabase-js";
import { mergeSettings } from "../../_shared/adapters/settings.ts";
import { dayNumber } from "../../_shared/core/calendar.ts";
import type { RunInfo } from "../types.ts";
import { chunk, exchangeOfSweepKey } from "./batching.ts";

/** Table access helpers shared by the stage handlers. PostgREST returns at most 1,000 rows per request, so reads are paged. */

export class DbQueryError extends Error {
  constructor(
    readonly op: string,
    message: string,
  ) {
    super(`${op}: ${message}`);
    this.name = "DbQueryError";
  }
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Primary key columns of the tables that do not have an `id` column (every other table pages by `id`). */
const PK_WITHOUT_ID: Readonly<Record<string, readonly string[]>> = {
  app_settings: ["key"],
  exchanges: ["code"],
  ibkr_catalogue: ["exchange_id", "conid"],
  notification_preferences: ["user_id"],
  price_series: ["security_id"],
  profiles: ["user_id"],
  quote_cache: ["key"],
  research_work_texts: ["report_id", "evidence_id"],
  risk_monitor_state: ["user_id", "security_id"],
};

/** PostgREST pages are only stable with a deterministic order: order by the primary key. */
const orderByPk = <Q extends { order(column: string): Q }>(q: Q, table: string): Q =>
  (PK_WITHOUT_ID[table] ?? ["id"]).reduce((acc, col) => acc.order(col), q);

export async function fetchAll<T = Record<string, unknown>>(
  op: string,
  page: (from: number, to: number) => PageResult<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new DbQueryError(op, error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: PostgREST builder generics are not worth threading through paged helpers
export type Query = any;

/** All rows of a table (paged), optionally narrowed by `apply`, e.g. (q) => q.eq("scan_run_id", id). */
export async function selectAll<T = Record<string, unknown>>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  apply: (q: Query) => Query = (q) => q,
): Promise<T[]> {
  return await fetchAll<T>(
    `${table}.select`,
    (a, b) => orderByPk(apply(sb.from(table).select(columns)), table).range(a, b) as PageResult<T>,
  );
}

/** Reads rows whose `idColumn` is in `ids`, 100 ids per request (URL length). */
export async function fetchByIds<T = Record<string, unknown>>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  idColumn: string,
  ids: readonly string[],
  apply: (q: Query) => Query = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    const rows = await fetchAll<T>(
      `${table}.by_ids`,
      (a, b) =>
        orderByPk(apply(sb.from(table).select(columns)).in(idColumn, part), table).range(
          a,
          b,
        ) as unknown as PageResult<T>,
    );
    out.push(...rows);
  }
  return out;
}

export async function upsertChunks(
  sb: SupabaseClient,
  table: string,
  rows: Array<Record<string, unknown>>,
  onConflict: string,
  size = 300,
): Promise<void> {
  for (const part of chunk(rows, size)) {
    const { error } = await sb.from(table).upsert(part, { onConflict });
    if (error) throw new DbQueryError(`${table}.upsert`, error.message);
  }
}

export async function insertChunks(
  sb: SupabaseClient,
  table: string,
  rows: Array<Record<string, unknown>>,
  size = 300,
): Promise<void> {
  for (const part of chunk(rows, size)) {
    const { error } = await sb.from(table).insert(part);
    if (error) throw new DbQueryError(`${table}.insert`, error.message);
  }
}

export async function deleteWhereRun(
  sb: SupabaseClient,
  table: string,
  runId: string,
): Promise<void> {
  const { error } = await sb.from(table).delete().eq("scan_run_id", runId);
  if (error) throw new DbQueryError(`${table}.delete`, error.message);
}

export function dayOfDate(iso: string): number {
  return dayNumber(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
}

// ------------------------------------------------------------------------------------------------ run

export async function loadRun(sb: SupabaseClient, runId: string): Promise<RunInfo> {
  const { data, error } = await sb
    .from("scan_runs")
    .select("id, scan_date_local, started_at, settings_snapshot")
    .eq("id", runId)
    .single();
  if (error) throw new DbQueryError("scan_runs.load", error.message);
  const snapshot = (data.settings_snapshot ?? {}) as Record<string, unknown>;
  const rows = ["indicator", "universe", "pipeline"]
    .filter((k) => k in snapshot)
    .map((key) => ({ key, value: snapshot[key] }));
  const { settings } = mergeSettings(rows);
  return {
    id: data.id as string,
    scanDateLocal: data.scan_date_local as string,
    scanDay: dayOfDate(data.scan_date_local as string),
    startedAtMs: Date.parse(data.started_at as string),
    settings,
    providerMode: snapshot["provider_mode"] === "fixture" ? "fixture" : "live",
    fixtureSet:
      typeof snapshot["fixture_set"] === "string" ? (snapshot["fixture_set"] as string) : null,
  };
}

/** The runs a worker may still advance: not yet terminal by status, newest first. */
export async function activeRunIds(sb: SupabaseClient): Promise<string[]> {
  const { data, error } = await sb
    .from("scan_runs")
    .select("id")
    .in("status", ["queued", "running", "partial"])
    .order("scan_date_local", { ascending: false })
    .limit(5);
  if (error) throw new DbQueryError("scan_runs.active", error.message);
  return (data ?? []).map((r: { id: string }) => r.id);
}

// ------------------------------------------------------------------------------------------------ fx

export interface FxEntry {
  ccy: string;
  usdPerUnit: number;
  rateDate: string;
  source: string;
}

/** Newest rate per currency. Input order does not matter. */
export function pickLatestRates(
  rows: ReadonlyArray<{ ccy: string; usd_per_unit: number; rate_date: string; source: string }>,
): Map<string, FxEntry> {
  const out = new Map<string, FxEntry>();
  for (const r of rows) {
    const ccy = r.ccy.trim();
    const have = out.get(ccy);
    if (have === undefined || r.rate_date > have.rateDate)
      out.set(ccy, { ccy, usdPerUnit: r.usd_per_unit, rateDate: r.rate_date, source: r.source });
  }
  return out;
}

/** Latest rate_date <= the scan date for every currency, looking back 10 days. */
export async function loadFxMap(
  sb: SupabaseClient,
  scanDateIso: string,
): Promise<Map<string, FxEntry>> {
  const from = new Date(Date.parse(`${scanDateIso}T00:00:00Z`) - 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await fetchAll<{
    ccy: string;
    usd_per_unit: number;
    rate_date: string;
    source: string;
  }>(
    "fx_rates.load",
    (a, b) =>
      sb
        .from("fx_rates")
        .select("ccy, usd_per_unit, rate_date, source")
        .gte("rate_date", from)
        .lte("rate_date", scanDateIso)
        .order("id")
        .range(a, b) as unknown as PageResult<{
        ccy: string;
        usd_per_unit: number;
        rate_date: string;
        source: string;
      }>,
  );
  return pickLatestRates(rows);
}

// ------------------------------------------------------------------------------------------------ exchanges and candidates

export interface ExchangeRow {
  code: string;
  country: string;
  timezone: string;
  currencies: string[];
  venue_class: "primary" | "secondary_only" | "otc";
  screener_enabled: boolean;
  trading_days: number[];
  session_close_local: string | null;
  max_gap_days: number;
  us_primary: boolean;
}

export async function loadExchanges(sb: SupabaseClient): Promise<Map<string, ExchangeRow>> {
  const rows = await fetchAll<ExchangeRow>(
    "exchanges.load",
    (a, b) =>
      sb
        .from("exchanges")
        .select(
          "code, country, timezone, currencies, venue_class, screener_enabled, trading_days, session_close_local, max_gap_days, us_primary",
        )
        .order("code")
        .range(a, b) as unknown as PageResult<ExchangeRow>,
  );
  return new Map(rows.map((r) => [r.code, r]));
}

export interface Candidate {
  securityId: string;
  companyId: string;
  yahooSymbol: string;
}

/** A canonical security is a scan candidate when its market cap is unknown (data problem) or at least the threshold. */
export function isCandidateCap(marketCapUsd: number | null, thresholdUsd: number): boolean {
  return marketCapUsd === null || marketCapUsd >= thresholdUsd;
}

/**
 * Candidates of a scan: canonical, active equities with a market-cap snapshot in this run whose cap is unknown or >= the threshold.
 * Sorted by symbol so batches are stable across retries.
 */
export async function selectCandidates(
  sb: SupabaseClient,
  runId: string,
  thresholdUsd: number,
): Promise<Candidate[]> {
  const securities = await fetchAll<{ id: string; company_id: string; yahoo_symbol: string }>(
    "securities.canonical",
    (a, b) =>
      sb
        .from("securities")
        .select("id, company_id, yahoo_symbol")
        .eq("is_canonical", true)
        .eq("status", "active")
        .eq("quote_type", "EQUITY")
        .order("id")
        .range(a, b) as unknown as PageResult<{
        id: string;
        company_id: string;
        yahoo_symbol: string;
      }>,
  );
  const snaps = await fetchAll<{ security_id: string; market_cap_usd: number | null }>(
    "market_cap_snapshots.run",
    (a, b) =>
      sb
        .from("market_cap_snapshots")
        .select("security_id, market_cap_usd")
        .eq("scan_run_id", runId)
        .order("id")
        .range(a, b) as unknown as PageResult<{
        security_id: string;
        market_cap_usd: number | null;
      }>,
  );
  const cap = new Map(snaps.map((s) => [s.security_id, s.market_cap_usd]));
  return securities
    .filter((s) => cap.has(s.id) && isCandidateCap(cap.get(s.id) ?? null, thresholdUsd))
    .map((s) => ({ securityId: s.id, companyId: s.company_id, yahooSymbol: s.yahoo_symbol }))
    .sort((a, b) => (a.yahooSymbol < b.yahooSymbol ? -1 : a.yahooSymbol > b.yahooSymbol ? 1 : 0));
}

export function isoOfMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function dateOfMs(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

/** Exchanges whose sweep job (any page) is dead in this run: their securities got no fresh data. */
export async function deadSweepExchanges(sb: SupabaseClient, runId: string): Promise<string[]> {
  const jobs = await selectAll<{ key: string; status: string }>(
    sb,
    "scan_jobs",
    "key, status",
    (q) => q.eq("scan_run_id", runId).eq("stage", "universe_sweep"),
  );
  return [
    ...new Set(
      jobs
        .filter((j) => j.status === "dead")
        .map((j) => exchangeOfSweepKey(j.key))
        .filter((c): c is string => c !== null),
    ),
  ];
}

/** Worldwide members of the newest list-published scan before `scanDateLocal`, with the exchange of each security. */
export async function previousMembers(
  sb: SupabaseClient,
  scanDateLocal: string,
): Promise<Array<{ securityId: string; exchange: string | null }>> {
  const { data, error } = await sb
    .from("scan_runs")
    .select("id")
    .not("list_published_at", "is", null)
    .lt("scan_date_local", scanDateLocal)
    .order("scan_date_local", { ascending: false })
    .limit(1);
  if (error) throw new DbQueryError("scan_runs.previous", error.message);
  const prev = (data as Array<{ id: string }> | null)?.[0];
  if (prev === undefined) return [];
  const rows = await selectAll<{ security_id: string }>(
    sb,
    "universe_snapshots",
    "security_id",
    (q) => q.eq("scan_run_id", prev.id).eq("mode", "worldwide"),
  );
  const secs = await fetchByIds<{ id: string; exchange_code: string }>(
    sb,
    "securities",
    "id, exchange_code",
    "id",
    rows.map((r) => r.security_id),
  );
  const exchangeOf = new Map(secs.map((s) => [s.id, s.exchange_code]));
  return rows.map((r) => ({
    securityId: r.security_id,
    exchange: exchangeOf.get(r.security_id) ?? null,
  }));
}
