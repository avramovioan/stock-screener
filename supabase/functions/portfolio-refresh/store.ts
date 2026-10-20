import type { Channel } from "@core/indicator.ts";
import type { HeldPosition } from "@core/portfolio-view.ts";
import { yahooSymbolForHolding } from "@core/yahoo-symbol.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RefreshConnection, RefreshStore } from "./handler.ts";
import type { CachedRow, QuoteKv } from "./quotes.ts";

export class RefreshStoreError extends Error {
  constructor(
    readonly op: string,
    readonly code: string | null,
  ) {
    super(`portfolio-refresh store: ${op}${code === null ? "" : ` (${code})`}`);
    this.name = "RefreshStoreError";
  }
}

const dayMinus = (iso: string, days: number): string => {
  const t =
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) -
    days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

export function createRefreshStore(sb: SupabaseClient): RefreshStore {
  return {
    async latestPublishedRunId() {
      const { data, error } = await sb
        .from("scan_runs")
        .select("id")
        .not("results_published_at", "is", null)
        .order("results_published_at", { ascending: false })
        .limit(1);
      if (error) throw new RefreshStoreError("latestPublishedRunId", error.code ?? null);
      return ((data as Array<{ id: string }> | null) ?? [])[0]?.id ?? null;
    },
    async claimHoldingRevalue(userId, conid) {
      const { data, error } = await sb
        .schema("app")
        .rpc("claim_holding_revalue", { p_user: userId, p_conid: conid });
      if (error) throw new RefreshStoreError("claimHoldingRevalue", error.code ?? null);
      const row = ((data as Array<{
        outcome: string;
        signal_security_id: string | null;
        next_allowed_at: string | null;
      }> | null) ?? [])[0];
      const outcome = row?.outcome;
      return {
        outcome:
          outcome === "claimed" || outcome === "not_screened" || outcome === "cooldown"
            ? outcome
            : "not_found",
        signalSecurityId: row?.signal_security_id ?? null,
        nextAllowedAt: row?.next_allowed_at ?? null,
      };
    },
    async loadRevalueInput(runId, securityId) {
      const res = await sb
        .from("scan_security_results")
        .select("status,session_date,close,channel")
        .eq("scan_run_id", runId)
        .eq("security_id", securityId)
        .maybeSingle();
      if (res.error) throw new RefreshStoreError("scan_security_results", res.error.code ?? null);
      const sec = await sb
        .from("securities")
        .select("quote_type,company_id")
        .eq("id", securityId)
        .maybeSingle();
      if (sec.error) throw new RefreshStoreError("securities", sec.error.code ?? null);
      const rank = await sb
        .from("universe_snapshots")
        .select("rank")
        .eq("scan_run_id", runId)
        .eq("mode", "worldwide")
        .eq("security_id", securityId)
        .maybeSingle();
      if (rank.error) throw new RefreshStoreError("universe_snapshots", rank.error.code ?? null);
      const r = res.data as {
        status: string;
        session_date: string | null;
        close: number | null;
        channel: { end: Channel["end"] } | null;
      } | null;
      const s = sec.data as { quote_type: string; company_id: string } | null;
      return {
        result:
          r === null || s === null
            ? undefined
            : {
                securityId,
                status: r.status,
                sessionDate: r.session_date,
                close: r.close === null ? null : Number(r.close),
                channel: r.channel,
                quoteType: s.quote_type,
                companyId: s.company_id,
              },
        worldwideRank: (rank.data as { rank: number } | null)?.rank ?? null,
      };
    },
    async applyHoldingTag(userId, conid, t) {
      // the same rows the daily stage tags: the newest statement day of this user
      const latest = await sb
        .from("broker_positions")
        .select("report_date")
        .eq("user_id", userId)
        .order("report_date", { ascending: false })
        .limit(1);
      if (latest.error) throw new RefreshStoreError("applyHoldingTag", latest.error.code ?? null);
      const date = ((latest.data as Array<{ report_date: string }> | null) ?? [])[0]?.report_date;
      if (date === undefined) return;
      const { error } = await sb
        .from("broker_positions")
        .update({
          valuation_tag: t.tag,
          valuation_session_date: t.sessionDate,
          valuation_reason: t.reason,
        })
        .eq("user_id", userId)
        .eq("conid", conid)
        .eq("report_date", date);
      if (error) throw new RefreshStoreError("applyHoldingTag", error.code ?? null);
    },
    async getConnection(userId) {
      const { data, error } = await sb
        .from("broker_connections")
        .select(
          "status,base_currency,last_statement_date,next_flex_fetch_not_before,last_manual_refresh_at,last_sync_at,coverage_from",
        )
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RefreshStoreError("getConnection", error.code ?? null);
      return (data as RefreshConnection | null) ?? null;
    },
    async claimManualRefresh(userId) {
      const { data, error } = await sb
        .schema("app")
        .rpc("claim_manual_refresh", { p_user: userId });
      if (error) throw new RefreshStoreError("claimManualRefresh", error.code ?? null);
      const row = ((data as Array<{ claimed: boolean; available_at: string | null }> | null) ??
        [])[0];
      return { claimed: row?.claimed === true, availableAt: row?.available_at ?? null };
    },
    async loadLatestPositions(userId): Promise<HeldPosition[]> {
      const latest = await sb
        .from("broker_positions")
        .select("report_date")
        .eq("user_id", userId)
        .order("report_date", { ascending: false })
        .limit(1);
      const date = ((latest.data as Array<{ report_date: string }> | null) ?? [])[0]?.report_date;
      if (date === undefined) return [];
      const { data, error } = await sb
        .from("broker_positions")
        .select(
          "id,conid,symbol,description,asset_class,listing_exchange,currency,quantity,multiplier,cost_basis_money,cost_basis_price,mark_price,fifo_pnl_unrealized,fx_rate_to_base,report_date,security_id,valuation_tag,valuation_session_date,valuation_reason,match_status",
        )
        .eq("user_id", userId)
        .eq("report_date", date)
        .neq("quantity", 0);
      if (error) throw new RefreshStoreError("loadLatestPositions", error.code ?? null);
      const rows = (data as Array<Record<string, unknown>> | null) ?? [];
      const ids = [
        ...new Set(
          rows.flatMap((r) =>
            typeof r["security_id"] === "string" ? [r["security_id"] as string] : [],
          ),
        ),
      ];
      const symbols = new Map<string, string>();
      if (ids.length > 0) {
        const secs = await sb.from("securities").select("id,yahoo_symbol").in("id", ids);
        for (const s of (secs.data as Array<{ id: string; yahoo_symbol: string }> | null) ?? [])
          symbols.set(s.id, s.yahoo_symbol);
      }
      const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      return rows.map((r) => ({
        id: Number(r["id"]),
        conid: Number(r["conid"]),
        symbol: String(r["symbol"]),
        description: (r["description"] as string | null) ?? null,
        assetClass: (r["asset_class"] as string | null) ?? null,
        currency: String(r["currency"]),
        quantity: Number(r["quantity"]),
        multiplier: Number(r["multiplier"]),
        costBasisMoney: n(r["cost_basis_money"]),
        costBasisPrice: n(r["cost_basis_price"]),
        markPrice: n(r["mark_price"]),
        fifoPnlUnrealized: n(r["fifo_pnl_unrealized"]),
        fxRateToBase: n(r["fx_rate_to_base"]),
        reportDate: String(r["report_date"]),
        valuationSymbol:
          (typeof r["security_id"] === "string"
            ? symbols.get(r["security_id"] as string)
            : undefined) ??
          yahooSymbolForHolding(
            String(r["symbol"]),
            (r["listing_exchange"] as string | null) ?? null,
            (r["asset_class"] as string | null) ?? null,
          ),
        valuationTag: (r["valuation_tag"] as string | null) ?? null,
        valuationSessionDate: (r["valuation_session_date"] as string | null) ?? null,
        valuationReason: (r["valuation_reason"] as string | null) ?? null,
        matchStatus: String(r["match_status"]),
      }));
    },
    async hasActiveRun(userId) {
      const { data, error } = await sb
        .from("broker_sync_runs")
        .select("id")
        .eq("user_id", userId)
        .in("state", ["queued", "requested", "polling", "parsing"])
        .limit(1);
      if (error) throw new RefreshStoreError("hasActiveRun", error.code ?? null);
      return ((data as unknown[] | null) ?? []).length > 0;
    },
    async enqueueDailySync(userId, runDate, statementTo) {
      const conn = await sb
        .from("broker_connections")
        .select("id,last_statement_date,status")
        .eq("user_id", userId)
        .maybeSingle();
      const c = conn.data as {
        id: string;
        last_statement_date: string | null;
        status: string;
      } | null;
      if (c === null || c.status !== "linked") return false;
      const { error } = await sb.from("broker_sync_runs").insert({
        user_id: userId,
        connection_id: c.id,
        kind: "daily",
        state: "queued",
        statement_from: c.last_statement_date === null ? null : dayMinus(c.last_statement_date, 5),
        statement_to: statementTo,
        idempotency_key: `${userId}:daily:${runDate}`,
      });
      if (error?.code === "23505") return false;
      if (error) throw new RefreshStoreError("enqueueDailySync", error.code ?? null);
      return true;
    },
  };
}

export function createQuoteKv(sb: SupabaseClient): QuoteKv {
  return {
    async get(keys) {
      const { data, error } = await sb
        .from("quote_cache")
        .select("key,payload,fetched_at,expires_at")
        .in("key", keys);
      if (error) throw new RefreshStoreError("quote_cache.get", error.code ?? null);
      const out = new Map<string, CachedRow>();
      for (const r of (data as Array<{
        key: string;
        payload: unknown;
        fetched_at: string;
        expires_at: string;
      }> | null) ?? []) {
        out.set(r.key, {
          payload: r.payload,
          fetchedAt: Date.parse(r.fetched_at),
          expiresAt: Date.parse(r.expires_at),
        });
      }
      return out;
    },
    async put(entries) {
      const { error } = await sb.from("quote_cache").upsert(
        entries.map((e) => ({
          key: e.key,
          payload: e.payload,
          provider: "yahoo",
          fetched_at: new Date(e.fetchedAt).toISOString(),
          expires_at: new Date(e.expiresAt).toISOString(),
        })),
        { onConflict: "key" },
      );
      if (error) throw new RefreshStoreError("quote_cache.put", error.code ?? null);
    },
  };
}
