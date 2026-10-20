import type { SupabaseClient } from "@supabase/supabase-js";
import type { ListingFact, Override } from "../../_shared/core/identity.ts";
import { dayOfDate, type ExchangeRow, fetchAll, fetchByIds, loadExchanges } from "./data.ts";

export interface SecRow {
  id: string;
  company_id: string;
  yahoo_symbol: string;
  exchange_code: string;
  long_name: string | null;
  shares_outstanding: number | null;
  avg_usd_volume_30d: number | null;
  first_trade_date: string | null;
  is_canonical: boolean;
  role: string;
  volume_probe_at: string | null;
  currency: string;
  currency_major: string;
  minor_divisor: number;
  financial_currency: string | null;
  quote_type: string;
}
export interface CompanyRow {
  id: string;
  name: string;
  country: string | null;
  profile_refreshed_at: string | null;
}
export interface OverrideRow {
  kind: Override["kind"];
  yahoo_symbol: string;
  target_company_id: string | null;
}

export interface IdentityData {
  securities: Map<string, SecRow>;
  companies: Map<string, CompanyRow>;
  exchanges: Map<string, ExchangeRow>;
  capUsd: Map<string, number | null>;
  quality: Map<string, string>;
  barCounts: Map<string, number>;
  overrideRows: OverrideRow[];
  listings: ListingFact[];
  overrides: Override[];
}

const SEC_COLUMNS =
  "id, company_id, yahoo_symbol, exchange_code, long_name, shares_outstanding, avg_usd_volume_30d, first_trade_date, is_canonical, role, volume_probe_at, currency, currency_major, minor_divisor, financial_currency, quote_type";

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Everything identity needs: the securities seen in this run's snapshots plus the known canonical ones, their companies, venues,
 * USD caps, stored bar counts and the active manual overrides, already shaped as core ListingFacts.
 */
export async function loadIdentityData(sb: SupabaseClient, runId: string): Promise<IdentityData> {
  const snaps = await fetchAll<{
    security_id: string;
    market_cap_usd: number | null;
    quality: string;
  }>(
    "market_cap_snapshots.run",
    (a, b) =>
      sb
        .from("market_cap_snapshots")
        .select("security_id, market_cap_usd, quality")
        .eq("scan_run_id", runId)
        .order("id")
        .range(a, b) as unknown as Page<{
        security_id: string;
        market_cap_usd: number | null;
        quality: string;
      }>,
  );
  const canonical = await fetchAll<SecRow>(
    "securities.canonical",
    (a, b) =>
      sb
        .from("securities")
        .select(SEC_COLUMNS)
        .eq("is_canonical", true)
        .eq("status", "active")
        .order("id")
        .range(a, b) as unknown as Page<SecRow>,
  );
  const ids = [...new Set([...snaps.map((s) => s.security_id), ...canonical.map((s) => s.id)])];
  const rows = await fetchByIds<SecRow>(sb, "securities", SEC_COLUMNS, "id", ids);
  const securities = new Map(rows.map((r) => [r.id, r]));
  const companies = new Map(
    (
      await fetchByIds<CompanyRow>(
        sb,
        "companies",
        "id, name, country, profile_refreshed_at",
        "id",
        [...new Set(rows.map((r) => r.company_id))],
      )
    ).map((c) => [c.id, c]),
  );
  const exchanges = await loadExchanges(sb);
  const bars = await fetchByIds<{ security_id: string; bar_count: number }>(
    sb,
    "price_series",
    "security_id, bar_count",
    "security_id",
    ids,
  );
  const overrideRows = await fetchAll<OverrideRow>(
    "overrides.active",
    (a, b) =>
      sb
        .from("security_identity_overrides")
        .select("kind, yahoo_symbol, target_company_id")
        .eq("active", true)
        .order("id")
        .range(a, b) as unknown as Page<OverrideRow>,
  );

  // merge_into_company names a company; the pure grouping needs a symbol of that company
  const targets = [
    ...new Set(overrideRows.map((o) => o.target_company_id).filter((v): v is string => v !== null)),
  ];
  const targetSymbol = new Map<string, string>();
  if (targets.length > 0) {
    const targetSecs = await fetchByIds<{
      company_id: string;
      yahoo_symbol: string;
      is_canonical: boolean;
    }>(sb, "securities", "company_id, yahoo_symbol, is_canonical", "company_id", targets);
    for (const t of targetSecs.sort((a, b) => Number(b.is_canonical) - Number(a.is_canonical)))
      if (!targetSymbol.has(t.company_id)) targetSymbol.set(t.company_id, t.yahoo_symbol);
  }
  const overrides: Override[] = overrideRows.map((o) => ({
    kind: o.kind,
    yahooSymbol: o.yahoo_symbol,
    targetYahooSymbol:
      o.target_company_id === null ? null : (targetSymbol.get(o.target_company_id) ?? null),
  }));

  const capUsd = new Map(snaps.map((s) => [s.security_id, s.market_cap_usd]));
  const listings: ListingFact[] = rows.map((r) => {
    const ex = exchanges.get(r.exchange_code);
    return {
      securityId: r.id,
      symbol: r.yahoo_symbol,
      exchange: r.exchange_code,
      venueClass: ex?.venue_class ?? "secondary_only",
      exchangeCountry: ex?.country ?? "",
      longName: r.long_name,
      marketCapUsd: capUsd.get(r.id) ?? null,
      sharesOutstanding: r.shares_outstanding,
      avgUsdVolume30d: r.avg_usd_volume_30d,
      firstTradeDay: r.first_trade_date === null ? null : dayOfDate(r.first_trade_date),
      quoteType: r.quote_type,
      currency: r.currency_major,
      financialCurrency: r.financial_currency,
    };
  });
  return {
    securities,
    companies,
    exchanges,
    capUsd,
    quality: new Map(snaps.map((s) => [s.security_id, s.quality])),
    barCounts: new Map(bars.map((b) => [b.security_id, b.bar_count])),
    overrideRows,
    listings,
    overrides,
  };
}
