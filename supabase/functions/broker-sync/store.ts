import { type Sealed, toBytea } from "@adapters/crypto.ts";
import type { MarketDataProvider } from "@adapters/providers.ts";
import { normalizeName } from "@core/identity.ts";
import { resolveCurrency } from "@core/units.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type MatchOutcome,
  type MatchPorts,
  type MatchStore,
  orderForMatching,
  type PositionRef,
  type SecurityLite,
} from "./matching.ts";
import type { IngestPayload } from "./persist.ts";
import type {
  AuditEvent,
  ConnectionPatch,
  ConnectionRow,
  RunKind,
  RunPatch,
  RunRow,
  SyncStore,
} from "./types.ts";

/** Errors carry the operation and the PostgREST code only: row values (ciphertext, token) never end up in a message. */
export class StoreError extends Error {
  constructor(
    readonly op: string,
    readonly code: string | null,
  ) {
    super(`broker store: ${op}${code === null ? "" : ` (${code})`}`);
    this.name = "StoreError";
  }
}

const CONN_COLS =
  "id,user_id,status,flex_token_ciphertext,flex_token_iv,key_version,token_expires_on,query_id,account_id_masked,base_currency,account_type,linked_at,last_verified_at,last_sync_at,last_statement_date,last_error_code,last_error_message,last_error_at,next_flex_fetch_not_before,coverage_from";
const RUN_COLS =
  "id,user_id,connection_id,kind,state,reference_code,requested_at,poll_count,next_poll_at,statement_from,statement_to,error_code,error_message,rows_summary,idempotency_key";
const DATA_TABLES = [
  "broker_positions",
  "broker_trades",
  "broker_closed_lots",
  "broker_cash_transactions",
  "broker_corporate_actions",
  "broker_fx_rates",
  "broker_nav",
];

export function createSupabaseStore(sb: SupabaseClient): SyncStore {
  const app = () => sb.schema("app");
  const fail = (op: string, error: { code?: string } | null): never => {
    throw new StoreError(op, error?.code ?? null);
  };

  return {
    async getConnection(userId) {
      const { data, error } = await sb
        .from("broker_connections")
        .select(CONN_COLS)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("getConnection", error);
      return (data as ConnectionRow | null) ?? null;
    },
    async getConnectionById(id) {
      const { data, error } = await sb
        .from("broker_connections")
        .select(CONN_COLS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("getConnectionById", error);
      return (data as ConnectionRow | null) ?? null;
    },
    async upsertLinking(i) {
      const { data, error } = await sb
        .from("broker_connections")
        .upsert(
          {
            id: i.id,
            user_id: i.userId,
            status: "linking",
            flex_token_ciphertext: toBytea(i.sealed.ciphertext),
            flex_token_iv: toBytea(i.sealed.iv),
            key_version: i.sealed.version,
            query_id: i.queryId,
            token_expires_on: i.tokenExpiresOn,
            last_error_code: null,
            last_error_message: null,
            last_error_at: null,
          },
          { onConflict: "user_id" },
        )
        .select(CONN_COLS)
        .single();
      if (error) fail("upsertLinking", error);
      return data as unknown as ConnectionRow;
    },
    async patchConnection(id, patch: ConnectionPatch) {
      const { error } = await sb.from("broker_connections").update(patch).eq("id", id);
      if (error) fail("patchConnection", error);
    },
    async zeroToken(id) {
      const { error } = await sb
        .from("broker_connections")
        .update({
          status: "unlinked",
          flex_token_ciphertext: null,
          flex_token_iv: null,
          key_version: null,
          query_id: null,
          token_expires_on: null,
          linked_at: null,
          last_error_code: null,
          last_error_message: null,
          last_error_at: null,
          next_flex_fetch_not_before: null,
        })
        .eq("id", id);
      if (error) fail("zeroToken", error);
    },
    async deleteBrokerData(userId, o = {}) {
      for (const table of DATA_TABLES) {
        const { error } = await sb.from(table).delete().eq("user_id", userId);
        if (error) fail(`delete ${table}`, error);
      }
      if (o.includeRuns === true) {
        const { error } = await sb.from("broker_sync_runs").delete().eq("user_id", userId);
        if (error) fail("delete broker_sync_runs", error);
      }
    },
    async cancelActiveRuns(userId, reason) {
      const { error } = await sb
        .from("broker_sync_runs")
        .update({
          state: "failed",
          error_code: -7,
          error_message: reason,
          finished_at: new Date().toISOString(),
          lease_until: null,
          next_poll_at: null,
        })
        .eq("user_id", userId)
        .in("state", ["queued", "requested", "polling", "parsing"]);
      if (error) fail("cancelActiveRuns", error);
    },
    async createRun(i: {
      userId: string;
      connectionId: string;
      kind: RunKind;
      statementFrom: string | null;
      statementTo: string | null;
      idempotencyKey: string;
    }) {
      const { data, error } = await sb
        .from("broker_sync_runs")
        .insert({
          user_id: i.userId,
          connection_id: i.connectionId,
          kind: i.kind,
          state: "queued",
          statement_from: i.statementFrom,
          statement_to: i.statementTo,
          idempotency_key: i.idempotencyKey,
        })
        .select(RUN_COLS)
        .single();
      if (error?.code === "23505") return null;
      if (error) fail("createRun", error);
      return data as unknown as RunRow;
    },
    async getRun(id) {
      const { data, error } = await sb
        .from("broker_sync_runs")
        .select(RUN_COLS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("getRun", error);
      return (data as RunRow | null) ?? null;
    },
    async latestActiveRun(userId) {
      const { data, error } = await sb
        .from("broker_sync_runs")
        .select(RUN_COLS)
        .eq("user_id", userId)
        .in("state", ["queued", "requested", "polling", "parsing"])
        .limit(1);
      if (error) fail("latestActiveRun", error);
      return ((data as RunRow[] | null) ?? [])[0] ?? null;
    },
    async leaseRun(id, seconds) {
      const { data, error } = await app().rpc("lease_broker_run", {
        p_run: id,
        p_lease_seconds: seconds,
      });
      if (error) fail("leaseRun", error);
      return ((data as RunRow[] | null) ?? [])[0] ?? null;
    },
    async claimRuns(limit, seconds) {
      const { data, error } = await app().rpc("claim_broker_runs", {
        p_limit: limit,
        p_lease_seconds: seconds,
      });
      if (error) fail("claimRuns", error);
      return (data as RunRow[] | null) ?? [];
    },
    async patchRun(id, patch: RunPatch) {
      const { data, error } = await sb
        .from("broker_sync_runs")
        .update(patch)
        .eq("id", id)
        .select(RUN_COLS)
        .single();
      if (error) fail("patchRun", error);
      return data as unknown as RunRow;
    },
    async enqueueManualSync(userId) {
      const { data, error } = await app().rpc("enqueue_manual_sync", { p_user: userId });
      if (error) fail("enqueueManualSync", error);
      const row = ((data as Array<{
        run_id: string | null;
        outcome: "created" | "busy" | "cooldown" | "not_linked";
        retry_after_seconds: number;
      }> | null) ?? [])[0];
      if (row === undefined) return fail("enqueueManualSync", null);
      return {
        runId: row.run_id,
        outcome: row.outcome,
        retryAfterSeconds: row.retry_after_seconds,
      };
    },
    async ingest(runId, payload: IngestPayload) {
      const { data, error } = await app().rpc("broker_ingest_statement", {
        p_run_id: runId,
        p_payload: payload,
      });
      if (error) fail("ingest", error);
      const out = (data ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(out).filter(([k, v]) => k !== "report_date" && typeof v === "number"),
      ) as Record<string, number>;
    },
    async listConnectionsForRekey(current) {
      const { data, error } = await sb
        .from("broker_connections")
        .select(CONN_COLS)
        .not("key_version", "is", null)
        .neq("key_version", current)
        .not("flex_token_ciphertext", "is", null);
      if (error) fail("listConnectionsForRekey", error);
      return (data as ConnectionRow[] | null) ?? [];
    },
    async rekeyConnection(id, sealed: Sealed) {
      const { error } = await sb
        .from("broker_connections")
        .update({
          flex_token_ciphertext: toBytea(sealed.ciphertext),
          flex_token_iv: toBytea(sealed.iv),
          key_version: sealed.version,
        })
        .eq("id", id);
      if (error) fail("rekeyConnection", error);
    },
    async isAdmin(userId) {
      const { data, error } = await sb
        .from("profiles")
        .select("is_admin")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("isAdmin", error);
      return (data as { is_admin: boolean } | null)?.is_admin === true;
    },
    async audit(e: AuditEvent) {
      // audit_events: actor_id / action / target_type / target_id / details (same shape as scan-control); the data never holds tokens or symbols
      const { error } = await sb.from("audit_events").insert({
        actor_id: e.actorUserId,
        action: e.eventType,
        target_type: "broker_connection",
        target_id: null,
        details: { via: e.actor, ...e.data },
      });
      if (error) fail("audit", error);
    },
  };
}

const SEC_COLS =
  "id,yahoo_symbol,exchange_code,currency_major,quote_type,company_id,isin,is_canonical";

export function createMatchPorts(sb: SupabaseClient, market: MarketDataProvider): MatchPorts {
  return {
    async securitiesByIsin(isin) {
      const { data, error } = await sb
        .from("securities")
        .select(SEC_COLS)
        .eq("isin", isin)
        .eq("status", "active");
      if (error) throw new StoreError("securitiesByIsin", error.code ?? null);
      return (data as SecurityLite[] | null) ?? [];
    },
    async securityBySymbol(symbol) {
      const { data, error } = await sb
        .from("securities")
        .select(SEC_COLS)
        .eq("yahoo_symbol", symbol)
        .maybeSingle();
      if (error) throw new StoreError("securityBySymbol", error.code ?? null);
      return (data as SecurityLite | null) ?? null;
    },
    async exchangeByIbkrId(id) {
      const { data, error } = await sb
        .from("exchanges")
        .select("code,yahoo_suffix")
        .eq("ibkr_exchange_id", id)
        .limit(1);
      if (error) throw new StoreError("exchangeByIbkrId", error.code ?? null);
      const row = ((data as Array<{ code: string; yahoo_suffix: string | null }> | null) ?? [])[0];
      return row === undefined
        ? null
        : { code: row.code, yahooSuffix: row.yahoo_suffix === "" ? null : row.yahoo_suffix };
    },
    async canonicalOf(companyId) {
      const { data, error } = await sb
        .from("securities")
        .select(SEC_COLS)
        .eq("company_id", companyId)
        .eq("is_canonical", true)
        .maybeSingle();
      if (error) throw new StoreError("canonicalOf", error.code ?? null);
      return (data as SecurityLite | null) ?? null;
    },
    async setSecurityIsin(securityId, isin) {
      const { error } = await sb
        .from("securities")
        .update({ isin })
        .eq("id", securityId)
        .is("isin", null);
      if (error) throw new StoreError("setSecurityIsin", error.code ?? null);
    },
    async searchIsin(isin) {
      const { hits } = await market.search(isin, { quotesCount: 3, newsCount: 0 });
      return hits
        .filter((h) => h.quoteType === "EQUITY" || h.quoteType === "ETF")
        .map((h) => ({ symbol: h.symbol, quoteType: h.quoteType, exchange: h.exchange }));
    },
    async ensureSecurity(symbol) {
      const quote = (await market.quote([symbol]))[0];
      if (quote === undefined) return { error: "no_quote" };
      const exchange = await sb
        .from("exchanges")
        .select("code")
        .eq("code", quote.exchange)
        .maybeSingle();
      if (exchange.error || exchange.data === null) return { error: "unknown_exchange" };
      const name = quote.longName ?? quote.shortName ?? symbol;
      const company = await sb
        .from("companies")
        .insert({
          name,
          name_normalized: normalizeName(name),
          identity_note: "created_by_broker_match",
        })
        .select("id")
        .single();
      if (company.error) throw new StoreError("ensureSecurity.company", company.error.code ?? null);
      const unit = resolveCurrency(quote.currency);
      const created = await sb
        .from("securities")
        .insert({
          company_id: (company.data as { id: string }).id,
          yahoo_symbol: symbol,
          exchange_code: quote.exchange,
          currency: quote.currency,
          currency_major: unit.major,
          minor_divisor: unit.divisor,
          quote_type: quote.quoteType,
          long_name: quote.longName,
          financial_currency: quote.financialCurrency,
        })
        .select(SEC_COLS)
        .single();
      if (created.error)
        throw new StoreError("ensureSecurity.security", created.error.code ?? null);
      return created.data as unknown as SecurityLite;
    },
  };
}

export function createMatchStore(sb: SupabaseClient): MatchStore {
  return {
    async positionsToMatch(userId): Promise<PositionRef[]> {
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
          "id,conid,isin,symbol,listing_exchange,currency,asset_class,sub_category,valuation_reason",
        )
        .eq("user_id", userId)
        .eq("report_date", date)
        .eq("match_status", "unmatched");
      if (error) throw new StoreError("positionsToMatch", error.code ?? null);
      const rows = ((data as Array<Record<string, string | number | null>> | null) ?? []).map(
        (r) => ({
          attempted: r["valuation_reason"] !== null,
          id: r["id"] as number,
          conid: r["conid"] as number,
          isin: r["isin"] as string | null,
          symbol: r["symbol"] as string,
          listingExchange: r["listing_exchange"] as string | null,
          currency: r["currency"] as string,
          assetClass: r["asset_class"] as string | null,
          subCategory: r["sub_category"] as string | null,
        }),
      );
      // untried rows first; retries rotate daily so a long tail of persistent misses cannot starve the rest
      return orderForMatching(rows, Math.floor(Date.now() / 86_400_000)).map(
        ({ attempted: _a, ...ref }) => ref,
      );
    },
    async applyOutcome(_userId, o: MatchOutcome) {
      const unavailable = o.matchStatus === "unmatched" || o.matchStatus === "not_equity";
      const { error } = await sb
        .from("broker_positions")
        .update({
          security_id: o.securityId,
          signal_security_id: o.signalSecurityId,
          match_status: o.matchStatus,
          valuation_tag: unavailable ? "unavailable" : null,
          valuation_reason: unavailable
            ? o.reason === "no_match"
              ? "no Yahoo match"
              : (o.reason ?? "not evaluated")
            : null,
        })
        .eq("id", o.positionId);
      if (error) throw new StoreError("applyOutcome", error.code ?? null);
    },
  };
}
