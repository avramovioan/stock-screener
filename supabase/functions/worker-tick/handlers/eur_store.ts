import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogueRow } from "../../_shared/adapters/ibkr-catalogue.ts";
import { logLine } from "../../_shared/adapters/log.ts";
import type { EurExchange } from "../../_shared/core/handoff.ts";
import type { CanonicalSecurity, CatalogueCandidate } from "./eur_match.ts";
import type {
  CatalogueStore,
  EurEquivalentRow,
  FxRate,
  OverrideRow,
  ResolveStore,
} from "./eur_resolve.ts";

/** Service-role access for the EUR stages. Edge Functions only: it bypasses RLS and must never reach a browser or a log line. */

export class EurStoreError extends Error {
  constructor(
    readonly op: string,
    message: string,
  ) {
    super(`${op}: ${message}`);
    this.name = "EurStoreError";
  }
}

const CANDIDATE_COLUMNS = "exchange_id, conid, symbol, local_symbol, isin, description";
const LIMIT = 50;

function check<T>(op: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new EurStoreError(op, res.error.message);
  return res.data;
}

/** Letters, digits and spaces only: the value goes into an ILIKE pattern. */
const likeSafe = (s: string): string => s.replace(/[^\p{L}\p{N} ]/gu, "").trim();

export function createEurStore(sb: SupabaseClient): ResolveStore & CatalogueStore {
  const app = () => sb.schema("app");

  return {
    async getSetting(name) {
      const data = check(
        "app_settings.select",
        await sb.from("app_settings").select("value").eq("key", name).maybeSingle(),
      );
      return (data as { value: unknown } | null)?.value ?? null;
    },

    async setSetting(name, value) {
      check(
        "app_settings.upsert",
        await sb
          .from("app_settings")
          .upsert({ key: name, value, is_public: false }, { onConflict: "key" }),
      );
    },

    async loadSecurity(securityId) {
      const data = check(
        "securities.select",
        await sb
          .from("securities")
          .select(
            "id, yahoo_symbol, currency, currency_major, minor_divisor, long_name, shares_outstanding, isin, companies!company_id(name)",
          )
          .eq("id", securityId)
          .maybeSingle(),
      ) as {
        id: string;
        yahoo_symbol: string;
        currency: string;
        currency_major: string;
        minor_divisor: number;
        long_name: string | null;
        shares_outstanding: number | null;
        isin: string | null;
        companies: { name: string } | { name: string }[] | null;
      } | null;
      if (data === null) return null;
      const company = Array.isArray(data.companies) ? data.companies[0] : data.companies;
      const security: CanonicalSecurity = {
        id: data.id,
        yahooSymbol: data.yahoo_symbol,
        currency: data.currency,
        currencyMajor: data.currency_major,
        minorDivisor: data.minor_divisor,
        longName: data.long_name,
        companyName: company?.name ?? data.long_name ?? data.yahoo_symbol,
        sharesOutstanding: data.shares_outstanding,
        isin: data.isin,
      };
      return security;
    },

    /** ISINs of positions held in any listing of the company (Flex, spec 12.7). The table arrives with P5; before that this is empty. */
    async heldIsins(securityId) {
      const own = check(
        "securities.company",
        await sb.from("securities").select("company_id").eq("id", securityId).maybeSingle(),
      ) as { company_id: string } | null;
      if (own === null) return [];
      const siblings = check(
        "securities.siblings",
        await sb.from("securities").select("id").eq("company_id", own.company_id),
      ) as { id: string }[];
      const res = await sb
        .from("broker_positions")
        .select("isin")
        .or(
          `security_id.in.(${siblings.map((s) => s.id).join(",")}),signal_security_id.eq.${securityId}`,
        )
        .not("isin", "is", null);
      if (res.error) {
        // Only an undefined table (before P5) means "no held ISINs"; every other read error is real.
        if (res.error.code === "42P01") return [];
        logLine("held_isins_read_failed", { code: res.error.code, message: res.error.message });
        throw new EurStoreError("broker_positions.select", res.error.message);
      }
      return [...new Set((res.data as { isin: string }[]).map((r) => r.isin))];
    },

    async activeOverrides(securityId) {
      const data = check(
        "eur_equivalent_overrides.select",
        await sb
          .from("eur_equivalent_overrides")
          .select(
            "id, ibkr_exchange_id, action, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, isin, reason",
          )
          .eq("security_id", securityId)
          .eq("active", true),
      );
      return (data ?? []) as OverrideRow[];
    },

    async findCandidates(q) {
      const base = () =>
        sb
          .from("ibkr_catalogue")
          .select(CANDIDATE_COLUMNS)
          .in("exchange_id", ["IBIS", "AEB"])
          .eq("product_type", "STK")
          .eq("currency", "EUR")
          .limit(LIMIT);
      const found: CatalogueCandidate[] = [];
      const add = (rows: unknown): void => {
        for (const r of (rows ?? []) as Record<string, unknown>[]) {
          found.push({
            exchange_id: r["exchange_id"] as EurExchange,
            conid: Number(r["conid"]),
            symbol: String(r["symbol"]),
            local_symbol: String(r["local_symbol"]),
            isin: (r["isin"] as string | null) ?? null,
            description: (r["description"] as string | null) ?? null,
          });
        }
      };
      if (q.isins.length > 0)
        add(check("ibkr_catalogue.by_isin", await base().in("isin", q.isins)));
      if (q.baseTicker !== "")
        add(check("ibkr_catalogue.by_symbol", await base().eq("symbol", q.baseTicker)));
      const prefix = likeSafe(q.namePrefix);
      if (prefix.length >= 3)
        add(check("ibkr_catalogue.by_name", await base().ilike("description", `${prefix}%`)));
      const unique = new Map<string, CatalogueCandidate>();
      for (const c of found) unique.set(`${c.exchange_id}:${c.conid}`, c);
      return [...unique.values()];
    },

    async loadFx(currencies, scanDate) {
      const data = check(
        "fx_rates.select",
        await sb
          .from("fx_rates")
          .select("ccy, usd_per_unit, rate_date")
          .in("ccy", currencies)
          .lte("rate_date", scanDate)
          .order("rate_date", { ascending: false })
          .limit(currencies.length * 8),
      ) as { ccy: string; usd_per_unit: number; rate_date: string }[];
      const out = new Map<string, FxRate>();
      for (const r of data ?? [])
        if (!out.has(r.ccy)) out.set(r.ccy, { usdPerUnit: r.usd_per_unit, rateDate: r.rate_date });
      return out;
    },

    async currentEquivalents(securityId: string) {
      const data = check(
        "eur_equivalents.select",
        await sb
          .from("eur_equivalents")
          .select(
            "ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, status, verification, verified_at",
          )
          .eq("security_id", securityId),
      );
      return (data ?? []) as EurEquivalentRow[];
    },

    async replaceEquivalents(securityId: string, rows: EurEquivalentRow[]) {
      check(
        "replace_eur_equivalents",
        await app().rpc("replace_eur_equivalents", { p_security_id: securityId, p_rows: rows }),
      );
    },

    async setSecurityIsin(securityId, isin) {
      check(
        "securities.set_isin",
        await sb.from("securities").update({ isin }).eq("id", securityId).is("isin", null),
      );
    },

    async resolveTargets(runId, limit) {
      const data = check(
        "eur_resolve_targets",
        await app().rpc("eur_resolve_targets", { p_run: runId, p_limit: limit }),
      );
      return ((data ?? []) as string[]).map(String);
    },

    async upsertCatalogue(rows: CatalogueRow[]) {
      if (rows.length === 0) return;
      check(
        "ibkr_catalogue.upsert",
        await sb.from("ibkr_catalogue").upsert(rows, { onConflict: "exchange_id,conid" }),
      );
    },
  };
}
