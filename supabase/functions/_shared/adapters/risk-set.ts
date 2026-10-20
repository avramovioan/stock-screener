// Holdings that need the daily material-change monitor of P2 (spec 9.7): operating companies that are outside the worldwide top 50,
// not universe members, or below US$50B.
import type { SupabaseClient } from "@supabase/supabase-js";

export const TOP_N = 50;
export const MIN_CAP_USD = 50e9;

export interface RiskHolding {
  userId: string;
  /** the signal (canonical) security, falling back to the held line */
  securityId: string;
  isOperating: boolean;
  worldwideRank: number | null;
  marketCapUsd: number | null;
}

export interface RiskSetStore {
  holdings(userId?: string): Promise<RiskHolding[]>;
  /** upserts `active` rows (reasons) for the user and pauses the user's other rows; never deletes findings */
  syncState(
    userId: string,
    active: Array<{ securityId: string; reasons: string[] }>,
  ): Promise<void>;
  pause(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
}

export function monitoredReasons(i: {
  isOperatingCompany: boolean;
  worldwideRank: number | null;
  marketCapUsd: number | null;
}): string[] {
  if (!i.isOperatingCompany) return [];
  const reasons: string[] = [];
  if (i.worldwideRank === null) reasons.push("not_in_universe");
  else if (i.worldwideRank > TOP_N) reasons.push("outside_top50");
  if (i.marketCapUsd !== null && i.marketCapUsd < MIN_CAP_USD) reasons.push("below_50b");
  return reasons;
}

export async function refreshRiskSet(
  store: RiskSetStore,
  userId?: string,
): Promise<{ monitored: number }> {
  const all = await store.holdings(userId);
  const byUser = new Map<string, RiskHolding[]>();
  for (const h of all) byUser.set(h.userId, [...(byUser.get(h.userId) ?? []), h]);
  if (userId !== undefined && !byUser.has(userId)) byUser.set(userId, []);
  let monitored = 0;
  for (const [user, holdings] of byUser) {
    const active = holdings
      .map((h) => ({
        securityId: h.securityId,
        reasons: monitoredReasons({
          isOperatingCompany: h.isOperating,
          worldwideRank: h.worldwideRank,
          marketCapUsd: h.marketCapUsd,
        }),
      }))
      .filter((r) => r.reasons.length > 0);
    await store.syncState(user, active);
    monitored += active.length;
  }
  return { monitored };
}

/** Row values never end up in a message: the operation and the PostgREST code only. */
export class RiskStoreError extends Error {
  constructor(
    readonly op: string,
    readonly code: string | null,
  ) {
    super(`risk set store: ${op}${code === null ? "" : ` (${code})`}`);
    this.name = "RiskStoreError";
  }
}

export function createRiskSetStore(sb: SupabaseClient): RiskSetStore {
  return {
    async holdings(userId): Promise<RiskHolding[]> {
      const users: string[] = [];
      if (userId !== undefined) users.push(userId);
      else {
        const { data, error } = await sb
          .from("broker_connections")
          .select("user_id")
          .in("status", ["linked", "error", "expired"]);
        if (error) throw new RiskStoreError("broker_connections", error.code ?? null);
        for (const r of (data as Array<{ user_id: string }> | null) ?? []) users.push(r.user_id);
      }
      const out: RiskHolding[] = [];
      const runs = await sb
        .from("scan_runs")
        .select("id")
        .not("list_published_at", "is", null)
        .order("scan_date_local", { ascending: false })
        .limit(1);
      if (runs.error) throw new RiskStoreError("scan_runs", runs.error.code ?? null);
      const runId = ((runs.data as Array<{ id: string }> | null) ?? [])[0]?.id ?? null;
      for (const u of users) {
        const { data, error } = await sb.rpc("monitored_holdings_for", { p_user: u });
        if (error) throw new RiskStoreError("monitored_holdings_for", error.code ?? null);
        const rows =
          (data as Array<{ security_id: string; signal_security_id: string }> | null) ?? [];
        const ids = [...new Set(rows.map((r) => r.signal_security_id))];
        if (ids.length === 0) continue;
        const secs = await sb.from("securities").select("id,quote_type").in("id", ids);
        const types = new Map(
          ((secs.data as Array<{ id: string; quote_type: string }> | null) ?? []).map((s) => [
            s.id,
            s.quote_type,
          ]),
        );
        // rank and market cap come from the latest published scan run only: a security that left the universe has no row there
        // (older runs and their rows never decide membership)
        const latest = new Map<string, { rank: number; cap: number }>();
        const capOf = new Map<string, number>();
        if (runId !== null) {
          for (let i = 0; i < ids.length; i += 100) {
            const part = ids.slice(i, i + 100);
            const snaps = await sb
              .from("universe_snapshots")
              .select("security_id,rank,market_cap_usd")
              .eq("scan_run_id", runId)
              .eq("mode", "worldwide")
              .in("security_id", part);
            if (snaps.error)
              throw new RiskStoreError("universe_snapshots", snaps.error.code ?? null);
            for (const s of (snaps.data as Array<{
              security_id: string;
              rank: number;
              market_cap_usd: number;
            }> | null) ?? [])
              latest.set(s.security_id, { rank: s.rank, cap: s.market_cap_usd });
            const caps = await sb
              .from("scan_security_results")
              .select("security_id,market_cap_usd")
              .eq("scan_run_id", runId)
              .in("security_id", part)
              .not("market_cap_usd", "is", null);
            if (caps.error)
              throw new RiskStoreError("scan_security_results", caps.error.code ?? null);
            for (const c of (caps.data as Array<{
              security_id: string;
              market_cap_usd: number;
            }> | null) ?? [])
              capOf.set(c.security_id, c.market_cap_usd);
          }
        }
        for (const id of ids) {
          out.push({
            userId: u,
            securityId: id,
            isOperating: types.get(id) === "EQUITY",
            worldwideRank: latest.get(id)?.rank ?? null,
            marketCapUsd: latest.get(id)?.cap ?? capOf.get(id) ?? null,
          });
        }
      }
      return out;
    },
    async syncState(userId, active) {
      if (active.length > 0) {
        const { error } = await sb.from("risk_monitor_state").upsert(
          active.map((a) => ({
            user_id: userId,
            security_id: a.securityId,
            reasons: a.reasons,
            status: "active",
          })),
          { onConflict: "user_id,security_id" },
        );
        if (error) throw new RiskStoreError("risk_monitor_state.upsert", error.code ?? null);
      }
      let q = sb
        .from("risk_monitor_state")
        .update({ status: "paused" })
        .eq("user_id", userId)
        .eq("status", "active");
      if (active.length > 0)
        q = q.not("security_id", "in", `(${active.map((a) => a.securityId).join(",")})`);
      const { error } = await q;
      if (error) throw new RiskStoreError("risk_monitor_state.pause", error.code ?? null);
    },
    async pause(userId) {
      const { error } = await sb
        .from("risk_monitor_state")
        .update({ status: "paused" })
        .eq("user_id", userId);
      if (error) throw new RiskStoreError("risk_monitor_state.pauseAll", error.code ?? null);
    },
    async remove(userId) {
      const { error } = await sb.from("risk_monitor_state").delete().eq("user_id", userId);
      if (error) throw new RiskStoreError("risk_monitor_state.remove", error.code ?? null);
    },
  };
}
