import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AcceptVisitor,
  CardPatch,
  CardRow,
  CardUpdate,
  LatestItems,
  NewJob,
  NewReport,
  NewSource,
  ReportPatch,
  ReportRow,
  ResearchStore,
  SecurityContext,
  SourcePatch,
  SourceRow,
} from "./research_types.ts";

type Row = Record<string, unknown>;

function fail(op: string, error: { message: string } | null): void {
  if (error) throw new Error(`research store ${op}: ${error.message}`);
}

const REPORT_COLUMNS: Record<string, string> = {
  scanRunId: "scan_run_id",
  status: "status",
  step: "step",
  notBefore: "not_before",
  isCurrent: "is_current",
  visibility: "visibility",
  reportMd: "report_md",
  summary: "summary",
  newsSummary: "news_summary",
  conclusion: "conclusion",
  bankruptcyRisk: "bankruptcy_risk",
  materialDamageEstablished: "material_damage_established",
  sufficientEvidence: "sufficient_evidence",
  citedEvidenceIds: "cited_evidence_ids",
  claims: "claims",
  missingDocuments: "missing_documents",
  limitations: "limitations",
  researchCutoffDate: "research_cutoff_date",
  startedAt: "started_at",
  completedAt: "completed_at",
  provider: "provider",
  model: "model",
  promptVersion: "prompt_version",
  schemaVersion: "schema_version",
  fallbackReason: "fallback_reason",
  waitReason: "wait_reason",
  lastAttemptAt: "last_attempt_at",
  nextAttemptAt: "next_attempt_at",
  nextProvider: "next_provider",
  evidenceTrimmed: "evidence_trimmed",
  usage: "usage",
  queriesUsed: "queries_used",
  docsFetched: "docs_fetched",
  error: "error",
  supersedesId: "supersedes_id",
  trigger: "trigger",
};

const toReport = (r: Row): ReportRow => ({
  id: r.id as string,
  securityId: r.security_id as string,
  companyId: r.company_id as string,
  scanRunId: (r.scan_run_id as string | null) ?? null,
  trigger: r.trigger as ReportRow["trigger"],
  status: r.status as ReportRow["status"],
  step: (r.step as string | null) ?? null,
  notBefore: (r.not_before as string | null) ?? null,
  isCurrent: Boolean(r.is_current),
  visibility: r.visibility as ReportRow["visibility"],
  reportMd: (r.report_md as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  newsSummary: (r.news_summary as string | null) ?? null,
  conclusion: (r.conclusion as ReportRow["conclusion"]) ?? null,
  bankruptcyRisk: (r.bankruptcy_risk as ReportRow["bankruptcyRisk"]) ?? null,
  materialDamageEstablished: (r.material_damage_established as boolean | null) ?? null,
  sufficientEvidence: (r.sufficient_evidence as boolean | null) ?? null,
  citedEvidenceIds: (r.cited_evidence_ids as number[] | null) ?? [],
  claims: r.claims ?? [],
  missingDocuments: (r.missing_documents as string[] | null) ?? [],
  limitations: (r.limitations as string[] | null) ?? [],
  researchCutoffDate: (r.research_cutoff_date as string | null) ?? null,
  startedAt: (r.started_at as string | null) ?? null,
  completedAt: (r.completed_at as string | null) ?? null,
  provider: (r.provider as string | null) ?? null,
  model: (r.model as string | null) ?? null,
  promptVersion: (r.prompt_version as string | null) ?? null,
  schemaVersion: (r.schema_version as string | null) ?? null,
  fallbackReason: (r.fallback_reason as ReportRow["fallbackReason"]) ?? null,
  waitReason: (r.wait_reason as ReportRow["waitReason"]) ?? null,
  lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
  nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
  nextProvider: (r.next_provider as string | null) ?? null,
  evidenceTrimmed: (r.evidence_trimmed as boolean | null) ?? null,
  usage: (r.usage as ReportRow["usage"]) ?? {},
  queriesUsed: Number(r.queries_used ?? 0),
  docsFetched: Number(r.docs_fetched ?? 0),
  error: (r.error as string | null) ?? null,
  supersedesId: (r.supersedes_id as string | null) ?? null,
  idempotencyKey: r.idempotency_key as string,
  updatedAt: (r.updated_at as string | null) ?? null,
});

const toSource = (r: Row): SourceRow => ({
  reportId: r.report_id as string,
  evidenceId: Number(r.evidence_id),
  url: r.url as string,
  canonicalUrl: r.canonical_url as string,
  title: (r.title as string | null) ?? null,
  publisher: (r.publisher as string | null) ?? null,
  kind: r.kind as SourceRow["kind"],
  publishedAt: (r.published_at as string | null) ?? null,
  filingDate: (r.filing_date as string | null) ?? null,
  retrievedAt: (r.retrieved_at as string | null) ?? null,
  httpStatus: (r.http_status as number | null) ?? null,
  contentType: (r.content_type as string | null) ?? null,
  contentHash: (r.content_hash as string | null) ?? null,
  excerpt: (r.excerpt as string | null) ?? null,
  extracted: (r.extracted as SourceRow["extracted"]) ?? [],
  livenessVerifiedAt: (r.liveness_verified_at as string | null) ?? null,
  verification: r.verification as SourceRow["verification"],
  usedInReport: Boolean(r.used_in_report),
  meta: (r.meta as SourceRow["meta"]) ?? {},
});

const SOURCE_COLUMNS: Record<string, string> = {
  title: "title",
  publisher: "publisher",
  kind: "kind",
  publishedAt: "published_at",
  filingDate: "filing_date",
  retrievedAt: "retrieved_at",
  httpStatus: "http_status",
  contentType: "content_type",
  contentHash: "content_hash",
  excerpt: "excerpt",
  extracted: "extracted",
  livenessVerifiedAt: "liveness_verified_at",
  verification: "verification",
  usedInReport: "used_in_report",
  meta: "meta",
  url: "url",
  canonicalUrl: "canonical_url",
};

function mapPatch(patch: Record<string, unknown>, columns: Record<string, string>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (column && value !== undefined) out[column] = value;
  }
  return out;
}

const utcDayStart = (now: Date) => now.toISOString().slice(0, 10);
const utcMonthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;

export function createSupabaseResearchStore(
  db: SupabaseClient,
  now: () => Date = () => new Date(),
): ResearchStore {
  const reportById = async (id: string): Promise<ReportRow | null> => {
    const { data, error } = await db
      .from("research_reports")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    fail("getReport", error);
    return data ? toReport(data as Row) : null;
  };
  const listSources = async (reportId: string): Promise<SourceRow[]> => {
    const { data, error } = await db
      .from("research_sources")
      .select("*")
      .eq("report_id", reportId)
      .order("evidence_id");
    fail("listSources", error);
    return ((data ?? []) as Row[]).map(toSource);
  };

  return {
    async loadSecurity(securityId): Promise<SecurityContext | null> {
      const { data, error } = await db
        .from("securities")
        .select(
          "id, company_id, yahoo_symbol, financial_currency, currency_major, companies!company_id(name, sector, industry, sec_cik, ir_rss_urls, news_symbol), exchanges(name)",
        )
        .eq("id", securityId)
        .maybeSingle();
      fail("loadSecurity", error);
      if (!data) return null;
      const row = data as unknown as Row & { companies: Row; exchanges: Row };
      return {
        securityId: row.id as string,
        companyId: row.company_id as string,
        companyName: row.companies.name as string,
        ticker: row.yahoo_symbol as string,
        primaryExchange: (row.exchanges?.name as string) ?? "",
        reportingCurrency:
          ((row.financial_currency as string | null) ?? (row.currency_major as string)) || "",
        sector: (row.companies.sector as string | null) ?? null,
        industry: (row.companies.industry as string | null) ?? null,
        secCik: (row.companies.sec_cik as string | null) ?? null,
        irRssUrls: (row.companies.ir_rss_urls as string[] | null) ?? [],
        newsSymbol: (row.companies.news_symbol as string | null) ?? null,
      };
    },
    async saveSecCik(companyId, cik) {
      const { error } = await db.from("companies").update({ sec_cik: cik }).eq("id", companyId);
      fail("saveSecCik", error);
    },
    async hasDiscountCard(securityId) {
      const { count, error } = await db
        .from("todays_discounts")
        .select("id", { count: "exact", head: true })
        .eq("security_id", securityId);
      fail("hasDiscountCard", error);
      return (count ?? 0) > 0;
    },
    async findReportByKey(key) {
      const { data, error } = await db
        .from("research_reports")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      fail("findReportByKey", error);
      return data ? toReport(data as Row) : null;
    },
    async createReport(input: NewReport) {
      const { error } = await db.from("research_reports").upsert(
        {
          idempotency_key: input.idempotencyKey,
          security_id: input.securityId,
          company_id: input.companyId,
          scan_run_id: input.scanRunId,
          trigger: input.trigger,
          visibility: input.visibility,
          kind: "full",
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
      fail("createReport", error);
      const { data, error: readError } = await db
        .from("research_reports")
        .select("*")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      fail("createReport(read)", readError);
      return toReport(data as Row);
    },
    getReport: reportById,
    async patchReport(id, patch: ReportPatch) {
      const { error } = await db
        .from("research_reports")
        .update(mapPatch(patch, REPORT_COLUMNS))
        .eq("id", id);
      fail("patchReport", error);
    },
    async deleteReport(id) {
      const unlink = await db
        .from("todays_discounts")
        .update({ research_report_id: null, report_id: null })
        .eq("research_report_id", id);
      fail("deleteReport(unlink)", unlink.error);
      const { error } = await db.from("research_reports").delete().eq("id", id);
      fail("deleteReport", error);
    },
    async currentReport(securityId) {
      const { data, error } = await db
        .from("research_reports")
        .select("*")
        .eq("security_id", securityId)
        .eq("is_current", true)
        .maybeSingle();
      fail("currentReport", error);
      return data ? toReport(data as Row) : null;
    },
    async hasInflightReport(securityId) {
      const { count, error } = await db
        .from("research_reports")
        .select("id", { count: "exact", head: true })
        .eq("security_id", securityId)
        .or("status.in.(running,quota_deferred),and(status.eq.queued,wait_reason.not.is.null)");
      fail("hasInflightReport", error);
      return (count ?? 0) > 0;
    },
    async hasActiveReport(securityId) {
      const { count, error } = await db
        .from("research_reports")
        .select("id", { count: "exact", head: true })
        .eq("security_id", securityId)
        .in("status", ["queued", "running", "quota_deferred"]);
      fail("hasActiveReport", error);
      return (count ?? 0) > 0;
    },
    async lastReportCompletedAt(securityId) {
      const { data, error } = await db
        .from("research_reports")
        .select("completed_at")
        .eq("security_id", securityId)
        .eq("status", "complete")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      fail("lastReportCompletedAt", error);
      return (data as { completed_at: string } | null)?.completed_at ?? null;
    },
    async listPersistingDiscounts(scanRunId) {
      const { data, error } = await db
        .from("todays_discounts")
        .select("security_id")
        .eq("scan_run_id", scanRunId)
        .eq("mode", "worldwide")
        .eq("is_new_episode", false)
        .not("research_report_id", "is", null);
      fail("listPersistingDiscounts", error);
      return [...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id))];
    },
    async hasAnyReport(securityId) {
      const { count, error } = await db
        .from("research_reports")
        .select("id", { count: "exact", head: true })
        .eq("security_id", securityId);
      fail("hasAnyReport", error);
      return (count ?? 0) > 0;
    },
    async hasOpenFindingSince(securityId, sinceIso) {
      const { count, error } = await db
        .from("risk_findings")
        .select("id", { count: "exact", head: true })
        .eq("security_id", securityId)
        .is("resolved_at", null)
        .gt("detected_at", sinceIso);
      fail("hasOpenFindingSince", error);
      return (count ?? 0) > 0;
    },
    async promoteReport(reportId) {
      const { data, error } = await db.rpc("promote_research_report_rpc", {
        p_report_id: reportId,
      });
      fail("promoteReport", error);
      return (data as string | null) ?? null;
    },
    listSources,
    async addSources(reportId, rows: NewSource[]) {
      const existing = await listSources(reportId);
      const seen = new Set(existing.map((s) => s.canonicalUrl));
      let nextId = Math.max(0, ...existing.map((s) => s.evidenceId)) + 1;
      const payload: Row[] = [];
      for (const r of rows) {
        if (seen.has(r.canonicalUrl)) continue;
        seen.add(r.canonicalUrl);
        payload.push({
          report_id: reportId,
          evidence_id: nextId++,
          url: r.url,
          canonical_url: r.canonicalUrl,
          title: r.title,
          publisher: r.publisher,
          kind: r.kind,
          published_at: r.publishedAt,
          filing_date: r.filingDate,
          excerpt: r.excerpt,
          meta: r.meta,
        });
      }
      if (payload.length === 0) return [];
      const { data, error } = await db.from("research_sources").insert(payload).select();
      fail("addSources", error);
      return ((data ?? []) as Row[]).map(toSource);
    },
    async patchSource(reportId, evidenceId, patch: SourcePatch) {
      const { error } = await db
        .from("research_sources")
        .update(mapPatch(patch, SOURCE_COLUMNS))
        .eq("report_id", reportId)
        .eq("evidence_id", evidenceId);
      fail("patchSource", error);
    },
    async clearSources(reportId) {
      const { error } = await db.from("research_sources").delete().eq("report_id", reportId);
      fail("clearSources", error);
    },
    async putWorkText(reportId, evidenceId, text) {
      const { error } = await db
        .from("research_work_texts")
        .upsert(
          { report_id: reportId, evidence_id: evidenceId, text },
          { onConflict: "report_id,evidence_id" },
        );
      fail("putWorkText", error);
    },
    async getWorkText(reportId, evidenceId) {
      const { data, error } = await db
        .from("research_work_texts")
        .select("text")
        .eq("report_id", reportId)
        .eq("evidence_id", evidenceId)
        .maybeSingle();
      fail("getWorkText", error);
      return (data as { text: string } | null)?.text ?? null;
    },
    async deleteWorkTexts(reportId) {
      const { error } = await db.from("research_work_texts").delete().eq("report_id", reportId);
      fail("deleteWorkTexts", error);
    },
    async consumeQuota(provider, resource, amount, period, limit) {
      const { data, error } = await db.rpc("consume_quota_rpc", {
        p_provider: provider,
        p_resource: resource,
        p_amount: amount,
        p_period_kind: period,
        p_limit: limit,
      });
      fail("consumeQuota", error);
      return data === true;
    },
    async quotaUsed(provider, resource, period) {
      const start = period === "day" ? utcDayStart(now()) : utcMonthStart(now());
      const { data, error } = await db
        .from("ai_quota_usage")
        .select("used")
        .eq("provider", provider)
        .eq("resource", resource)
        .eq("period_kind", period)
        .eq("period_start", start)
        .maybeSingle();
      fail("quotaUsed", error);
      return Number((data as { used: number } | null)?.used ?? 0);
    },
    async enqueueJob(job: NewJob) {
      const { error } = await db.from("scan_jobs").upsert(
        {
          scan_run_id: job.scanRunId,
          stage: job.stage,
          key: job.key,
          payload: job.payload,
          priority: job.priority ?? 100,
          ...(job.notBefore ? { not_before: job.notBefore } : {}),
        },
        { onConflict: "scan_run_id,stage,key", ignoreDuplicates: true },
      );
      fail("enqueueJob", error);
    },
    async acceptVisitorResearch(input: AcceptVisitor) {
      const { data, error } = await db.rpc("accept_visitor_research", {
        p_security_id: input.securityId,
        p_scan_run_id: input.scanRunId,
        p_accepted_at: input.acceptedAt,
        p_report_key: input.reportKey,
        p_job_key: input.job.key,
        p_priority: input.job.priority ?? 100,
        p_payload: input.job.payload,
      });
      fail("acceptVisitorResearch", error);
      const row = (Array.isArray(data) ? data[0] : data) as {
        accepted: boolean;
        report_id: string | null;
        started_at: string | null;
        requested_by: string | null;
      } | null;
      if (!row) throw new Error("research store acceptVisitorResearch: empty answer");
      if (row.accepted && row.report_id)
        return { accepted: true as const, reportId: row.report_id, startedAt: input.acceptedAt };
      const by = row.requested_by;
      return {
        accepted: false as const,
        startedAt: row.started_at,
        requestedBy: by === "visitor" || by === "owner" || by === "system" ? by : null,
      };
    },
    async applyReportToCards(u: CardUpdate) {
      const { data, error } = await db
        .from("todays_discounts")
        .update({
          operational_category: u.category,
          category_reason: u.reasonCode,
          withheld: !(u.category === "green" || u.category === "amber"),
          ...(u.reportId ? { research_report_id: u.reportId, report_id: u.reportId } : {}),
          research_summary: u.summary,
          summary: u.summary,
          conclusion: u.conclusion,
          bankruptcy_risk: u.bankruptcyRisk,
          research_completed_at: u.completedAt,
        })
        .eq("scan_run_id", u.scanRunId)
        .eq("security_id", u.securityId)
        .select("id");
      fail("applyReportToCards", error);
      return (data ?? []).length;
    },
    async hasPendingCard(scanRunId, securityId) {
      const { count, error } = await db
        .from("todays_discounts")
        .select("id", { count: "exact", head: true })
        .eq("scan_run_id", scanRunId)
        .eq("security_id", securityId)
        .eq("operational_category", "pending");
      fail("hasPendingCard", error);
      return (count ?? 0) > 0;
    },
    async listCards(scanRunId) {
      const { data, error } = await db
        .from("todays_discounts")
        .select(
          "id, mode, security_id, rank, operational_category, research_report_id, securities(yahoo_symbol)",
        )
        .eq("scan_run_id", scanRunId);
      fail("listCards", error);
      return ((data ?? []) as unknown as Row[]).map(
        (r): CardRow => ({
          id: Number(r.id),
          mode: r.mode as string,
          securityId: r.security_id as string,
          rank: Number(r.rank),
          symbol: ((r.securities as Row | null)?.yahoo_symbol as string) ?? "",
          researchReportId: (r.research_report_id as string | null) ?? null,
          operationalCategory: r.operational_category as string,
        }),
      );
    },
    async updateCard(id, patch: CardPatch) {
      const { error } = await db
        .from("todays_discounts")
        .update({
          operational_category: patch.category,
          category_reason: patch.reasonCode,
          withheld: !(patch.category === "green" || patch.category === "amber"),
          research_report_id: patch.reportId,
          report_id: patch.reportId,
          research_summary: patch.summary,
          summary: patch.summary,
          conclusion: patch.conclusion,
          bankruptcy_risk: patch.bankruptcyRisk,
          research_completed_at: patch.completedAt,
          display_order: patch.displayOrder,
        })
        .eq("id", id);
      fail("updateCard", error);
    },
    async updateMonitorReport(securityId, reportId, category) {
      const { error } = await db
        .from("risk_monitor_state")
        .update({ last_report_id: reportId, last_category: category })
        .eq("security_id", securityId);
      fail("updateMonitorReport", error);
    },
    async setLatestItems(securityId, latest: LatestItems) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select("user_id, last_seen_items")
        .eq("security_id", securityId);
      fail("setLatestItems(read)", error);
      for (const row of (data ?? []) as { user_id: string; last_seen_items: Row | null }[]) {
        const update = await db
          .from("risk_monitor_state")
          .update({ last_seen_items: { ...(row.last_seen_items ?? {}), latest } })
          .eq("user_id", row.user_id)
          .eq("security_id", securityId);
        fail("setLatestItems", update.error);
      }
    },
    async mergeCoverage(scanRunId, patch) {
      const { data, error } = await db
        .from("scan_runs")
        .select("coverage")
        .eq("id", scanRunId)
        .single();
      fail("mergeCoverage(read)", error);
      const current = (data as { coverage: Row } | null)?.coverage ?? {};
      const merged: Row = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        const old = current[key];
        const isObj = (v: unknown): v is Row =>
          typeof v === "object" && v !== null && !Array.isArray(v);
        // P1's publish:initial writes coverage.research = { required }; P2 adds its counts beside it
        merged[key] = isObj(old) && isObj(value) ? { ...old, ...value } : value;
      }
      const update = await db.from("scan_runs").update({ coverage: merged }).eq("id", scanRunId);
      fail("mergeCoverage", update.error);
    },
    async refreshScanStatus(scanRunId) {
      const { error } = await db.schema("app").rpc("refresh_scan_status", { p_run: scanRunId });
      fail("refreshScanStatus", error);
    },
    async latestScanRun() {
      const { data, error } = await db
        .from("scan_runs")
        .select("id, scan_date_local")
        .order("scan_date_local", { ascending: false })
        .limit(1)
        .maybeSingle();
      fail("latestScanRun", error);
      const row = data as { id: string; scan_date_local: string } | null;
      return row ? { id: row.id, scanDateLocal: row.scan_date_local } : null;
    },
    async latestPublishedRun() {
      const { data, error } = await db
        .from("scan_runs")
        .select("id, scan_date_local")
        .not("results_published_at", "is", null)
        .order("results_published_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      fail("latestPublishedRun", error);
      const row = data as { id: string; scan_date_local: string } | null;
      return row ? { id: row.id, scanDateLocal: row.scan_date_local } : null;
    },
    async listPendingDiscountSecurities(scanRunId) {
      const { data, error } = await db
        .from("todays_discounts")
        .select("security_id")
        .eq("scan_run_id", scanRunId)
        .eq("mode", "worldwide")
        .eq("operational_category", "pending");
      fail("listPendingDiscountSecurities", error);
      const ids = [
        ...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id)),
      ];
      if (ids.length === 0) return [];
      const busy = await db
        .from("research_reports")
        .select("security_id")
        .in("security_id", ids)
        .or("status.in.(running,quota_deferred),and(status.eq.queued,wait_reason.not.is.null)");
      fail("listPendingDiscountSecurities(inflight)", busy.error);
      const inflight = new Set(
        ((busy.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
      );
      return ids.filter((id) => !inflight.has(id));
    },
    async listPremiumSecurities(scanRunId) {
      const { data, error } = await db
        .from("signal_episodes")
        .select("security_id")
        .eq("opened_scan_run_id", scanRunId)
        .in("kind", ["premium1", "premium2"]);
      fail("listPremiumSecurities", error);
      return [...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id))];
    },
    async listStaleCurrentReports(olderThanIso) {
      const { data, error } = await db
        .from("research_reports")
        .select("id, security_id")
        .eq("is_current", true)
        .eq("status", "complete")
        .lt("completed_at", olderThanIso);
      fail("listStaleCurrentReports", error);
      const stale = (data ?? []) as { id: string; security_id: string }[];
      if (stale.length === 0) return [];
      const ids = stale.map((s) => s.security_id);
      const monitored = await db
        .from("risk_monitor_state")
        .select("security_id")
        .in("security_id", ids)
        .eq("status", "active");
      fail("listStaleCurrentReports(monitor)", monitored.error);
      const cards = await db.from("todays_discounts").select("security_id").in("security_id", ids);
      fail("listStaleCurrentReports(cards)", cards.error);
      const active = new Set([
        ...((monitored.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
        ...((cards.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
      ]);
      return stale
        .filter((s) => active.has(s.security_id))
        .map((s) => ({ securityId: s.security_id, reportId: s.id }));
    },
    async listDeferred(nowIso) {
      const { data, error } = await db
        .from("research_reports")
        .select("*")
        .eq("status", "quota_deferred")
        .lte("not_before", nowIso);
      fail("listDeferred", error);
      return ((data ?? []) as Row[]).map(toReport);
    },
    async failStaleParkedReports() {
      const { data, error } = await db
        .from("research_reports")
        .update({ status: "failed", error: "reset", completed_at: now().toISOString() })
        .or("status.eq.quota_deferred,and(status.eq.queued,wait_reason.not.is.null)")
        .not("trigger", "in", "(monitor_first,monitor_change)")
        .select("id");
      fail("failStaleParkedReports", error);
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
      if (ids.length > 0) {
        const jobs = await db
          .from("scan_jobs")
          .delete()
          .eq("stage", "research")
          .in("status", ["queued", "failed"])
          .in("payload->>report_id", ids);
        fail("failStaleParkedReports(jobs)", jobs.error);
      }
      return ids.length;
    },
    async exhaustedModels(nowIso) {
      const { data, error } = await db
        .from("llm_model_state")
        .select("model_key")
        .gt("exhausted_until", nowIso);
      fail("exhaustedModels", error);
      return ((data ?? []) as { model_key: string }[]).map((r) => r.model_key);
    },
    async markModelExhausted(key, untilIso, errorText) {
      const { error } = await db.from("llm_model_state").upsert(
        {
          model_key: key,
          exhausted_until: untilIso,
          last_error: errorText,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "model_key" },
      );
      fail("markModelExhausted", error);
    },
    async supersedeInflightReports(securityId, exceptReportId) {
      const { data, error } = await db
        .from("research_reports")
        .update({ status: "failed", error: "superseded" })
        .eq("security_id", securityId)
        .neq("id", exceptReportId)
        .in("status", ["queued", "running", "quota_deferred"])
        .select("id");
      fail("supersedeInflightReports", error);
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
      if (ids.length > 0) {
        const jobs = await db
          .from("scan_jobs")
          .delete()
          .eq("stage", "research")
          .eq("status", "queued")
          .in("payload->>report_id", ids);
        fail("supersedeInflightReports(jobs)", jobs.error);
      }
      return ids.length;
    },
    async listNewsTargets(scanRunId) {
      const cards = await db
        .from("todays_discounts")
        .select("security_id")
        .eq("scan_run_id", scanRunId);
      fail("listNewsTargets(cards)", cards.error);
      const monitored = await db
        .from("risk_monitor_state")
        .select("security_id")
        .eq("status", "active");
      fail("listNewsTargets(monitor)", monitored.error);
      return [
        ...new Set([
          ...((cards.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
          ...((monitored.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
        ]),
      ];
    },
  };
}
