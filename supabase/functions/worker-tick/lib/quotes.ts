import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { MARKET_CAP_MAX_AGE_DAYS, marketCapUsd as toUsd } from "../../_shared/core/eligibility.ts";
import { normalizeName } from "../../_shared/core/identity.ts";
import { instrumentRejection } from "../../_shared/core/instruments.ts";
import { resolveCurrency } from "../../_shared/core/units.ts";
import { chunk } from "./batching.ts";
import { DbQueryError, dateOfMs, type FxEntry, isoOfMs } from "./data.ts";

export type QuoteQuality = "ok" | "stale" | "missing" | "fx_missing";

export interface SnapshotInput {
  quality: QuoteQuality;
  /** last price (major unit) x shares outstanding, in the major currency; null when either input is missing (5.3). */
  marketCapNative: number | null;
  marketCapUsd: number | null;
  fx: FxEntry | null;
  currencyMajor: string;
  minorDivisor: number;
}

/**
 * Market-cap facts of one quote row (4.1, 4.6, 5.3). The cap is computed here: regularMarketPrice x sharesOutstanding, never Yahoo's own
 * marketCap. The price is in the quote unit (SHEL.L: GBp), so it is divided by the minor-unit divisor to land in the MAJOR unit (GBP),
 * and only the FX of the major currency applies afterwards.
 */
export function snapshotInput(
  row: Pick<
    QuoteRecord,
    "currency" | "sharesOutstanding" | "regularMarketPrice" | "regularMarketTime"
  >,
  fx: ReadonlyMap<string, FxEntry>,
  scanDay: number,
): SnapshotInput {
  const unit = resolveCurrency(row.currency);
  const entry = fx.get(unit.major) ?? null;
  let quality: QuoteQuality = "ok";
  let usd: number | null = null;
  const native =
    row.regularMarketPrice === null || row.sharesOutstanding === null
      ? null
      : (row.regularMarketPrice / unit.divisor) * row.sharesOutstanding;
  if (native === null) quality = "missing";
  else if (entry === null) quality = "fx_missing";
  else {
    usd = toUsd(native, entry.usdPerUnit);
    const ageDays =
      row.regularMarketTime === null
        ? null
        : scanDay - Math.floor(row.regularMarketTime / 86_400_000);
    if (ageDays === null || ageDays > MARKET_CAP_MAX_AGE_DAYS) {
      quality = "stale";
    }
  }
  return {
    quality,
    marketCapNative: native,
    marketCapUsd: usd,
    fx: entry,
    currencyMajor: unit.major,
    minorDivisor: unit.divisor,
  };
}

export interface ApplyOutcome {
  seen: number;
  kept: number;
  belowThreshold: number;
  created: number;
  updated: number;
  skippedUnknownExchange: number;
  /** Rows that are not common shares (bond, ETF, warrant, IOB line, bond-like name): never stored (A-50). */
  skippedInstrument: number;
}

/**
 * Writes quote-family rows (screener rows or quote() records) through app.apply_quote_rows.
 * keepBelowThreshold = false (sweep): rows under the USD floor are dropped, rows with unknown cap or FX are kept and flagged.
 * Only common shares are written (A-50): quoteType other than EQUITY, bond-like names and 0xxx.L international order book lines are skipped.
 * keepBelowThreshold = true (recheck): every known security is recorded so a removal is explained by a number.
 */
export async function applyQuoteRows(a: {
  sb: SupabaseClient;
  runId: string;
  scanDay: number;
  rows: QuoteRecord[];
  source: "yahoo_screener" | "yahoo_quote";
  fx: ReadonlyMap<string, FxEntry>;
  thresholdUsd: number;
  keepBelowThreshold: boolean;
  knownExchanges: ReadonlySet<string>;
}): Promise<ApplyOutcome> {
  const out: ApplyOutcome = {
    seen: a.rows.length,
    kept: 0,
    belowThreshold: 0,
    created: 0,
    updated: 0,
    skippedUnknownExchange: 0,
    skippedInstrument: 0,
  };
  const payload: Array<Record<string, unknown>> = [];
  const seenSymbols = new Set<string>(); // a repeated symbol would try to create the same security twice (unique yahoo_symbol)
  for (const row of a.rows) {
    if (seenSymbols.has(row.symbol)) continue;
    seenSymbols.add(row.symbol);
    if (
      instrumentRejection({
        symbol: row.symbol,
        quoteType: row.quoteType,
        name: row.longName ?? row.shortName,
      }) !== null
    ) {
      out.skippedInstrument += 1;
      continue;
    }
    if (!a.knownExchanges.has(row.exchange)) {
      out.skippedUnknownExchange += 1;
      continue;
    }
    const s = snapshotInput(row, a.fx, a.scanDay);
    if (!a.keepBelowThreshold && s.marketCapUsd !== null && s.marketCapUsd < a.thresholdUsd) {
      out.belowThreshold += 1;
      continue;
    }
    const name = row.longName ?? row.shortName ?? row.symbol;
    payload.push({
      yahoo_symbol: row.symbol,
      new_company_id: crypto.randomUUID(),
      name,
      name_normalized: normalizeName(name),
      exchange_code: row.exchange,
      currency: row.currency,
      currency_major: s.currencyMajor,
      minor_divisor: s.minorDivisor,
      quote_type: row.quoteType,
      long_name: row.longName,
      financial_currency: row.financialCurrency,
      shares_outstanding: row.sharesOutstanding === null ? null : Math.round(row.sharesOutstanding),
      first_trade_date: dateOfMs(row.firstTradeDateMs),
      market_cap_native: s.marketCapNative,
      fx_usd_per_unit: s.fx?.usdPerUnit ?? null,
      fx_rate_date: s.fx?.rateDate ?? null,
      fx_source: s.fx?.source ?? null,
      market_cap_usd: s.marketCapUsd,
      price_time: row.regularMarketTime === null ? null : isoOfMs(row.regularMarketTime),
      source: a.source,
      quality: s.quality,
    });
  }
  out.kept = payload.length;
  for (const part of chunk(payload, 250)) {
    const { data, error } = await a.sb
      .schema("app")
      .rpc("apply_quote_rows", { p_run: a.runId, p_rows: part });
    if (error) throw new DbQueryError("apply_quote_rows", error.message);
    const r = data as {
      created: number;
      updated: number;
      skipped_unknown_exchange: number;
    };
    out.created += r.created;
    out.updated += r.updated;
    out.skippedUnknownExchange += r.skipped_unknown_exchange;
  }
  return out;
}
