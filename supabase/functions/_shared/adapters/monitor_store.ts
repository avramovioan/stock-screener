import type { SupabaseClient } from "@supabase/supabase-js";
import type { LatestLike, SeenItems } from "../core/risk.ts";

export interface MonitorRow {
  userId: string;
  securityId: string;
  lastReportId: string | null;
  lastCategory: string | null;
  seen: SeenItems;
  latest: LatestLike;
  lastCheckAt: string | null;
  nextDueAt: string | null;
}

export interface OpenFinding {
  id: string;
  category: string;
  fingerprint: string;
  primaryUrls: string[];
}

export interface NewFinding {
  userId: string;
  securityId: string;
  fingerprint: string;
  category: string;
  severity: "material" | "watch";
  summary: string;
  evidence: { id: number; url: string; title: string; primary: boolean }[];
}

/**
 * Change-check state of a persisting discount that nobody holds (no `risk_monitor_state` row): kept on the security's
 * current report as `usage.watch`, so no extra table and no user id is involved.
 */
export interface WatchState {
  reportId: string;
  seen: SeenItems;
  lastCheckAt: string | null;
  nextDueAt: string | null;
}

export interface MonitorStore {
  /** Active monitor rows of one security (one per monitoring user). */
  rows(securityId: string): Promise<MonitorRow[]>;
  /** Securities with at least one active row that is due. */
  listDue(nowIso: string): Promise<string[]>;
  touch(
    securityId: string,
    patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems },
  ): Promise<void>;
  openFinding(userId: string, securityId: string, category: string): Promise<OpenFinding | null>;
  /** False when the (user, security, fingerprint) finding already exists. */
  insertFinding(finding: NewFinding): Promise<boolean>;
  updateFinding(
    id: string,
    patch: { summary: string; severity: string; evidence: NewFinding["evidence"] },
  ): Promise<void>;
  previousAssessment(
    securityId: string,
  ): Promise<{ category: string | null; summary: string | null; date: string | null } | null>;
  /** The watch state of a security without monitoring users, or null when it has no current complete report. */
  watch(securityId: string): Promise<WatchState | null>;
  touchWatch(
    reportId: string,
    patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems },
  ): Promise<void>;
}

type Row = Record<string, unknown>;
const check = (op: string, error: { message: string; code?: string } | null): void => {
  if (error) throw new Error(`monitor store ${op}: ${error.message}`);
};

export function createSupabaseMonitorStore(db: SupabaseClient): MonitorStore {
  return {
    async rows(securityId) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select(
          "user_id, security_id, last_report_id, last_category, last_seen_items, last_check_at, next_due_at",
        )
        .eq("security_id", securityId)
        .eq("status", "active");
      check("rows", error);
      return ((data ?? []) as Row[]).map((r) => {
        const items = (r.last_seen_items as { seen?: SeenItems; latest?: LatestLike } | null) ?? {};
        return {
          userId: r.user_id as string,
          securityId: r.security_id as string,
          lastReportId: (r.last_report_id as string | null) ?? null,
          lastCategory: (r.last_category as string | null) ?? null,
          seen: items.seen ?? {},
          latest: items.latest ?? {},
          lastCheckAt: (r.last_check_at as string | null) ?? null,
          nextDueAt: (r.next_due_at as string | null) ?? null,
        };
      });
    },
    async listDue(nowIso) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select("security_id")
        .eq("status", "active")
        .or(`next_due_at.is.null,next_due_at.lte.${nowIso}`);
      check("listDue", error);
      return [...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id))];
    },
    async touch(securityId, patch) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select("user_id, last_seen_items")
        .eq("security_id", securityId);
      check("touch(read)", error);
      for (const row of (data ?? []) as { user_id: string; last_seen_items: Row | null }[]) {
        const items = row.last_seen_items ?? {};
        const update = await db
          .from("risk_monitor_state")
          .update({
            last_check_at: patch.lastCheckAt,
            next_due_at: patch.nextDueAt,
            last_seen_items: patch.seen ? { ...items, seen: patch.seen } : items,
          })
          .eq("user_id", row.user_id)
          .eq("security_id", securityId);
        check("touch", update.error);
      }
    },
    async openFinding(userId, securityId, category) {
      const { data, error } = await db
        .from("risk_findings")
        .select("id, category, fingerprint, evidence")
        .eq("user_id", userId)
        .eq("security_id", securityId)
        .eq("category", category)
        .is("resolved_at", null)
        .order("detected_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      check("openFinding", error);
      if (!data) return null;
      const row = data as {
        id: string;
        category: string;
        fingerprint: string;
        evidence: { url: string; primary: boolean }[] | null;
      };
      return {
        id: row.id,
        category: row.category,
        fingerprint: row.fingerprint,
        primaryUrls: (row.evidence ?? []).filter((e) => e.primary).map((e) => e.url),
      };
    },
    async insertFinding(f) {
      const { error } = await db.from("risk_findings").insert({
        user_id: f.userId,
        security_id: f.securityId,
        fingerprint: f.fingerprint,
        category: f.category,
        severity: f.severity,
        summary: f.summary,
        evidence: f.evidence,
      });
      if (error?.code === "23505") return false;
      check("insertFinding", error);
      return true;
    },
    async updateFinding(id, patch) {
      const { error } = await db
        .from("risk_findings")
        .update({ summary: patch.summary, severity: patch.severity, evidence: patch.evidence })
        .eq("id", id);
      check("updateFinding", error);
    },
    async watch(securityId) {
      const { data, error } = await db
        .from("research_reports")
        .select("id, usage")
        .eq("security_id", securityId)
        .eq("is_current", true)
        .eq("status", "complete")
        .maybeSingle();
      check("watch", error);
      if (!data) return null;
      const row = data as { id: string; usage: { watch?: Row } | null };
      const w = row.usage?.watch ?? {};
      return {
        reportId: row.id,
        seen: (w.seen as SeenItems | undefined) ?? {},
        lastCheckAt: (w.last_check_at as string | undefined) ?? null,
        nextDueAt: (w.next_due_at as string | undefined) ?? null,
      };
    },
    async touchWatch(reportId, patch) {
      const read = await db
        .from("research_reports")
        .select("usage")
        .eq("id", reportId)
        .maybeSingle();
      check("touchWatch(read)", read.error);
      const usage = ((read.data as { usage: Row | null } | null)?.usage ?? {}) as {
        watch?: { seen?: SeenItems };
      } & Row;
      const update = await db
        .from("research_reports")
        .update({
          usage: {
            ...usage,
            watch: {
              seen: patch.seen ?? usage.watch?.seen ?? {},
              last_check_at: patch.lastCheckAt,
              next_due_at: patch.nextDueAt,
            },
          },
        })
        .eq("id", reportId);
      check("touchWatch", update.error);
    },
    async previousAssessment(securityId) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select("last_report_id, last_category")
        .eq("security_id", securityId)
        .limit(1)
        .maybeSingle();
      check("previousAssessment", error);
      const state = data as { last_report_id: string | null; last_category: string | null } | null;
      if (state === null) {
        // a persisting discount nobody holds: the assessment is the current report's
        const current = await db
          .from("research_reports")
          .select("summary, completed_at")
          .eq("security_id", securityId)
          .eq("is_current", true)
          .maybeSingle();
        check("previousAssessment(current)", current.error);
        const c = current.data as { summary: string | null; completed_at: string | null } | null;
        return c
          ? { category: null, summary: c.summary, date: c.completed_at?.slice(0, 10) ?? null }
          : null;
      }
      if (!state?.last_report_id)
        return state ? { category: state.last_category, summary: null, date: null } : null;
      const report = await db
        .from("research_reports")
        .select("summary, completed_at")
        .eq("id", state.last_report_id)
        .maybeSingle();
      check("previousAssessment(report)", report.error);
      const r = report.data as { summary: string | null; completed_at: string | null } | null;
      return {
        category: state.last_category,
        summary: r?.summary ?? null,
        date: r?.completed_at?.slice(0, 10) ?? null,
      };
    },
  };
}
