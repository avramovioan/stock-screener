import type { Clock } from "../../_shared/adapters/clock.ts";
import {
  type CatalogueFetch,
  type CatalogueRow,
  createImportBudget,
  type FetchExchangeResult,
  fetchExchangeProducts,
} from "../../_shared/adapters/ibkr-catalogue.ts";
import type { HandlerContext, SeedPlan } from "../types.ts";
import { isoWeek } from "./eur_match.ts";
import { type CatalogueStore, parseEurSettings } from "./eur_resolve.ts";

/**
 * Weekly import of IBKR's public IBIS and AEB product lists into `ibkr_catalogue` (spec 5.7, 7.4). Job key `eur_catalogue:<iso-week>`.
 *
 * Gentle by construction: one import per ISO week, one attempt per Sofia day, the attempt is recorded BEFORE the first request (a crash, a job
 * retry or a manual re-run the same day never repeats it), at most 35 pages and 50 requests, and any failure ends the import for the day.
 * Failure is data (`eur_catalogue_state`, a warning event), never a job failure: the scan must not degrade because a convenience list is late.
 * Permission to call the undocumented /webrest/* endpoints is UNVERIFIED (Q-10); `app_settings.eur_catalogue.enabled = false` switches the import off.
 */

export const EXCHANGES = ["IBIS", "AEB"] as const;
const UPSERT_CHUNK = 500;

export interface CatalogueState {
  last_success_week: string | null;
  last_success_at: string | null;
  last_attempt_day: string | null;
  last_result: "complete" | "aborted" | "error" | null;
  detail: Record<string, unknown> | null;
}

export function parseCatalogueState(raw: unknown): CatalogueState {
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const result = r["last_result"];
  return {
    last_success_week: str(r["last_success_week"]),
    last_success_at: str(r["last_success_at"]),
    last_attempt_day: str(r["last_attempt_day"]),
    last_result:
      result === "complete" || result === "aborted" || result === "error" ? result : null,
    detail:
      typeof r["detail"] === "object" && r["detail"] !== null
        ? (r["detail"] as Record<string, unknown>)
        : null,
  };
}

export interface EurCatalogueCtx {
  run: Pick<HandlerContext["run"], "scanDateLocal">;
  signal: AbortSignal;
  log: HandlerContext["log"];
}

export interface EurCatalogueDeps {
  store: CatalogueStore;
  fetchImpl: CatalogueFetch;
  clock: Pick<Clock, "now" | "sleep">;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runEurCatalogue(
  ctx: EurCatalogueCtx,
  deps: EurCatalogueDeps,
): Promise<Record<string, unknown>> {
  const { store, clock } = deps;
  const today = ctx.run.scanDateLocal;
  const week = isoWeek(today);

  if (!parseEurSettings(await store.getSetting("eur_catalogue")).enabled) {
    await ctx.log("eur_catalogue_skipped", { reason: "disabled", week });
    return { status: "skipped", reason: "disabled" };
  }
  const state = parseCatalogueState(await store.getSetting("eur_catalogue_state"));
  if (state.last_success_week === week)
    return { status: "skipped", reason: "already_imported_this_week", week };
  if (state.last_attempt_day === today) {
    await ctx.log(
      "eur_catalogue_skipped",
      { reason: "already_attempted_today", week },
      { level: "warn" },
    );
    return { status: "skipped", reason: "already_attempted_today", week };
  }

  await store.setSetting("eur_catalogue_state", {
    ...state,
    last_attempt_day: today,
    last_result: null,
    detail: null,
  });
  try {
    const budget = createImportBudget();
    const fetchedAt = new Date(clock.now()).toISOString();
    const results: FetchExchangeResult[] = [];
    for (const exchangeId of EXCHANGES) {
      ctx.signal.throwIfAborted();
      const result = await fetchExchangeProducts(exchangeId, {
        fetchImpl: deps.fetchImpl,
        clock,
        pause: (ms) => clock.sleep(ms),
        budget,
        signal: ctx.signal,
        fetchedAt,
      });
      results.push(result);
      if (result.aborted !== null) break;
    }
    // Only exchanges read to the end are written; an abandoned exchange keeps last week's rows untouched.
    const written: Record<string, number> = {};
    for (const r of results) {
      if (!r.complete) continue;
      for (const part of chunks<CatalogueRow>(r.rows, UPSERT_CHUNK))
        await store.upsertCatalogue(part);
      written[r.exchangeId] = r.rows.length;
    }
    const failed = results.find((r) => r.aborted !== null);
    const counts = {
      pages: budget.pages,
      requests: budget.requests,
      written,
      scanned: Object.fromEntries(results.map((r) => [r.exchangeId, r.scanned])),
    };
    if (failed === undefined && results.length === EXCHANGES.length) {
      await store.setSetting("eur_catalogue_state", {
        last_success_week: week,
        last_success_at: new Date(clock.now()).toISOString(),
        last_attempt_day: today,
        last_result: "complete",
        detail: counts,
      });
      await ctx.log("eur_catalogue_imported", { week, ...counts });
      return { status: "imported", week, ...counts };
    }
    const abort = { exchange: failed?.exchangeId ?? null, ...(failed?.aborted ?? {}) };
    await store.setSetting("eur_catalogue_state", {
      ...state,
      last_attempt_day: today,
      last_result: "aborted",
      detail: { ...counts, abort },
    });
    await ctx.log("eur_catalogue_aborted", { week, ...counts, abort }, { level: "warn" });
    return { status: "aborted", week, ...counts, abort };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const errorClass = e instanceof Error ? e.name : "error";
    await store.setSetting("eur_catalogue_state", {
      ...state,
      last_attempt_day: today,
      last_result: "error",
      detail: { error: errorClass },
    });
    await ctx.log("eur_catalogue_failed", { week, error: errorClass }, { level: "warn" });
    return { status: "error", week, error: errorClass };
  }
}

/** Always exactly one job per run, so every run records its decision (imported, or skipped: disabled, already imported this week, already attempted today) in scan_jobs.result. */
export function seedEurCatalogue(ctx: { run: { scanDateLocal: string } }): SeedPlan {
  return {
    keys: [`eur_catalogue:${isoWeek(ctx.run.scanDateLocal)}`],
    payloads: [{}],
    priorities: [130],
  };
}
