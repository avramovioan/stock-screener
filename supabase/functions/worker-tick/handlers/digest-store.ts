import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DigestStore,
  DigestUser,
  DiscountRow,
  InsertDigestArgs,
  InsertPublicDigestArgs,
  PortfolioCandidates,
  ScanRunInfo,
} from "./digest-stage.ts";

type Row = Record<string, unknown>;

function toDiscountRows(data: Row[]): DiscountRow[] {
  return data.map((r) => ({
    episodeId: String(r.episode_id),
    companyId: String(r.company_id),
    securityId: String(r.security_id),
    mode: r.mode as DiscountRow["mode"],
    rank: Number(r.rank),
    yahooSymbol: String(r.yahoo_symbol),
    exchangeCode: String(r.exchange_code ?? ""),
    name: String(r.name),
    close: Number(r.close),
    currency: String(r.currency),
    sessionDate: String(r.session_date),
    thresholdLine: String(r.threshold_line),
    isTop10: Boolean(r.is_top10),
    reachedLine4: Boolean(r.reached_line4),
    category: r.category === null ? null : String(r.category),
    conclusion: r.conclusion === null ? null : String(r.conclusion),
    bankruptcyRisk: r.bankruptcy_risk === null ? null : String(r.bankruptcy_risk),
    summary: String(r.summary ?? ""),
    eurSymbol: r.eur_symbol === null ? null : String(r.eur_symbol),
    eurStatus: r.eur_status === null ? null : String(r.eur_status),
  }));
}

export function createDigestStore(client: SupabaseClient): DigestStore {
  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name} failed: ${error.message}`);
    return data;
  }
  return {
    async scanRun(id): Promise<ScanRunInfo | null> {
      const { data, error } = await client
        .from("scan_runs")
        .select("id,status,scan_date_local,digests_created_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`scan_runs read failed: ${error.message}`);
      if (data === null) return null;
      const r = data as Row;
      return {
        id: String(r.id),
        status: String(r.status),
        scanDateLocal: String(r.scan_date_local),
        digestsCreatedAt: r.digests_created_at === null ? null : String(r.digests_created_at),
      };
    },
    async getUsers(): Promise<DigestUser[]> {
      return ((await rpc("notify_digest_users")) as Row[]).map((r) => ({
        userId: String(r.user_id),
        pushEnabled: Boolean(r.push_enabled),
        hasActivePush: Boolean(r.has_active_push),
        hasDiscountsPush: Boolean(r.has_discounts_push),
        hasPortfolioPush: Boolean(r.has_portfolio_push),
        modes: ["worldwide"], // one worldwide ranking; the country filter is applied in notify_discount_candidates
        sendEmpty: Boolean(r.send_empty),
        holdsPositions: Boolean(r.holds_positions),
      }));
    },
    async discountCandidates(scanRunId, userId, finishedOnly): Promise<DiscountRow[]> {
      return toDiscountRows(
        (await rpc("notify_discount_candidates", {
          p_scan_run: scanRunId,
          p_user: userId,
          p_finished_only: finishedOnly,
        })) as Row[],
      );
    },
    async publicDiscountCandidates(scanRunId): Promise<DiscountRow[]> {
      return toDiscountRows(
        (await rpc("notify_public_discount_candidates", { p_scan_run: scanRunId })) as Row[],
      );
    },
    async portfolioCandidates(scanRunId, userId): Promise<PortfolioCandidates> {
      return (await rpc("notify_portfolio_candidates", {
        p_scan_run: scanRunId,
        p_user: userId,
      })) as PortfolioCandidates;
    },
    async insertDigest(a: InsertDigestArgs): Promise<string | null> {
      const id = await rpc("notify_insert_digest", {
        p_scan_run: a.scanRunId,
        p_user: a.userId,
        p_kind: a.kind,
        p_content: a.content,
        p_hash: a.hash,
        p_reason: a.reason,
        p_status: a.status,
        p_skip_reason: a.skipReason,
        p_items: a.items,
        p_channels: a.channels,
        p_scan_date: a.scanDate,
      });
      return id === null ? null : String(id);
    },
    async insertPublicDigest(a: InsertPublicDigestArgs): Promise<string | null> {
      const id = await rpc("notify_insert_public_digest", {
        p_scan_run: a.scanRunId,
        p_content: a.content,
        p_hash: a.hash,
        p_reason: a.reason,
        p_status: a.status,
        p_skip_reason: a.skipReason,
        p_scan_date: a.scanDate,
      });
      return id === null ? null : String(id);
    },
    async finish(scanRunId, reason, stats): Promise<boolean> {
      return Boolean(
        await rpc("notify_finish_digests", {
          p_scan_run: scanRunId,
          p_reason: reason,
          p_stats: stats,
        }),
      );
    },
  };
}
