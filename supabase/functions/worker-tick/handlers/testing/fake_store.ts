import type {
  AcceptVisitor,
  AcceptVisitorResult,
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
} from "../../../_shared/adapters/research_types.ts";

export interface FakeCard extends CardRow {
  scanRunId: string;
  categoryReason?: string;
  withheld?: boolean;
  summary?: string | null;
  conclusion?: string | null;
  bankruptcyRisk?: string | null;
  completedAt?: string | null;
  displayOrder?: number;
}

export interface FakeJob extends NewJob {
  id: number;
  status: "queued" | "done";
}

/** In-memory ResearchStore. Mirrors the SQL rules the handlers rely on: unique key, canonical dedupe, quota cap. */
export class FakeStore implements ResearchStore {
  securities = new Map<string, SecurityContext>();
  reports = new Map<string, ReportRow>();
  sources = new Map<string, SourceRow[]>();
  texts = new Map<string, string>();
  cards: FakeCard[] = [];
  jobs: FakeJob[] = [];
  quota = new Map<string, number>();
  quotaCalls: { provider: string; resource: string; amount: number; granted: boolean }[] = [];
  discountCards = new Set<string>();
  findings: { securityId: string; detectedAt: string }[] = [];
  monitorLatest = new Map<string, LatestItems>();
  monitorReports = new Map<string, { reportId: string; category: string }>();
  coverage = new Map<string, Record<string, unknown>>();
  premium = new Map<string, string[]>();
  scanRuns: { id: string; scanDateLocal: string }[] = [];
  /** Id of the newest scan run with published results; null = none published yet. */
  publishedRunId: string | null = null;
  /** User-level data that must never reach a provider; privacy tests assert it stays here. */
  secrets: Record<string, string> = {};
  refreshed: string[] = [];
  /** `llm_model_state`: model key -> exhausted_until and the last error. */
  exhausted = new Map<string, { until: string; error: string }>();
  exhaustedReads = 0;
  private seq = 0;

  async loadSecurity(id: string) {
    const s = this.securities.get(id);
    return s ? structuredClone(s) : null;
  }
  async saveSecCik(companyId: string, cik: string) {
    for (const s of this.securities.values()) if (s.companyId === companyId) s.secCik = cik;
  }
  async hasDiscountCard(securityId: string) {
    return (
      this.discountCards.has(securityId) || this.cards.some((c) => c.securityId === securityId)
    );
  }
  async findReportByKey(key: string) {
    const r = [...this.reports.values()].find((x) => x.idempotencyKey === key);
    return r ? structuredClone(r) : null;
  }
  async createReport(input: NewReport) {
    const existing = await this.findReportByKey(input.idempotencyKey);
    if (existing) return existing;
    const row: ReportRow = {
      id: `rep-${++this.seq}`,
      securityId: input.securityId,
      companyId: input.companyId,
      scanRunId: input.scanRunId,
      trigger: input.trigger,
      status: "queued",
      step: null,
      notBefore: null,
      isCurrent: false,
      visibility: input.visibility,
      reportMd: null,
      summary: null,
      newsSummary: null,
      conclusion: null,
      bankruptcyRisk: null,
      materialDamageEstablished: null,
      sufficientEvidence: null,
      citedEvidenceIds: [],
      claims: [],
      missingDocuments: [],
      limitations: [],
      researchCutoffDate: null,
      startedAt: null,
      completedAt: null,
      provider: null,
      model: null,
      promptVersion: null,
      schemaVersion: null,
      fallbackReason: null,
      waitReason: null,
      lastAttemptAt: null,
      nextAttemptAt: null,
      nextProvider: null,
      evidenceTrimmed: null,
      usage: {},
      queriesUsed: 0,
      docsFetched: 0,
      error: null,
      supersedesId: null,
      idempotencyKey: input.idempotencyKey,
      updatedAt: null,
    };
    this.reports.set(row.id, row);
    return structuredClone(row);
  }
  async getReport(id: string) {
    const r = this.reports.get(id);
    return r ? structuredClone(r) : null;
  }
  async patchReport(id: string, patch: ReportPatch) {
    const row = this.reports.get(id);
    if (!row) throw new Error(`no report ${id}`);
    Object.assign(row, structuredClone(patch));
  }
  async deleteReport(id: string) {
    this.reports.delete(id);
    this.sources.delete(id);
  }
  async currentReport(securityId: string) {
    const r = [...this.reports.values()].find((x) => x.securityId === securityId && x.isCurrent);
    return r ? structuredClone(r) : null;
  }
  async hasInflightReport(securityId: string) {
    return [...this.reports.values()].some(
      (r) =>
        r.securityId === securityId &&
        (r.status === "running" ||
          r.status === "quota_deferred" ||
          (r.status === "queued" && r.waitReason !== null)), // a report waiting for a weekend or cadence slot is in flight
    );
  }
  async hasActiveReport(securityId: string) {
    return [...this.reports.values()].some(
      (r) =>
        r.securityId === securityId &&
        (r.status === "queued" || r.status === "running" || r.status === "quota_deferred"),
    );
  }
  async lastReportCompletedAt(securityId: string) {
    const times = [...this.reports.values()]
      .filter((r) => r.securityId === securityId && r.status === "complete" && r.completedAt)
      .map((r) => r.completedAt as string)
      .sort();
    return times.at(-1) ?? null;
  }
  persisting = new Set<string>();
  async listPersistingDiscounts(_scanRunId: string) {
    return [...this.persisting];
  }
  async hasAnyReport(securityId: string) {
    return [...this.reports.values()].some((r) => r.securityId === securityId);
  }
  async hasOpenFindingSince(securityId: string, sinceIso: string) {
    return this.findings.some((f) => f.securityId === securityId && f.detectedAt > sinceIso);
  }
  async promoteReport(reportId: string) {
    const row = this.reports.get(reportId);
    if (row?.status !== "complete") throw new Error("only a complete report can become current");
    let previous: string | null = null;
    for (const r of this.reports.values()) {
      if (r.securityId === row.securityId && r.isCurrent && r.id !== reportId) {
        previous = r.id;
        r.isCurrent = false;
      }
    }
    row.isCurrent = true;
    if (previous) row.supersedesId = previous;
    return previous;
  }
  async listSources(reportId: string) {
    return structuredClone(this.sources.get(reportId) ?? []);
  }
  async addSources(reportId: string, rows: NewSource[]) {
    const list = this.sources.get(reportId) ?? [];
    const inserted: SourceRow[] = [];
    for (const r of rows) {
      if (list.some((s) => s.canonicalUrl === r.canonicalUrl)) continue;
      const row: SourceRow = {
        reportId,
        evidenceId: Math.max(0, ...list.map((s) => s.evidenceId)) + 1,
        url: r.url,
        canonicalUrl: r.canonicalUrl,
        title: r.title,
        publisher: r.publisher,
        kind: r.kind,
        publishedAt: r.publishedAt,
        filingDate: r.filingDate,
        retrievedAt: null,
        httpStatus: null,
        contentType: null,
        contentHash: null,
        excerpt: r.excerpt,
        extracted: [],
        livenessVerifiedAt: null,
        verification: "pending",
        usedInReport: false,
        meta: { ...r.meta },
      };
      list.push(row);
      inserted.push(structuredClone(row));
    }
    this.sources.set(reportId, list);
    return inserted;
  }
  async patchSource(reportId: string, evidenceId: number, patch: SourcePatch) {
    const row = (this.sources.get(reportId) ?? []).find((s) => s.evidenceId === evidenceId);
    if (!row) throw new Error(`no source E${evidenceId}`);
    Object.assign(row, structuredClone(patch));
  }
  async clearSources(reportId: string) {
    this.sources.set(reportId, []);
  }
  async putWorkText(reportId: string, evidenceId: number, text: string) {
    this.texts.set(`${reportId}:${evidenceId}`, text);
  }
  async getWorkText(reportId: string, evidenceId: number) {
    return this.texts.get(`${reportId}:${evidenceId}`) ?? null;
  }
  async deleteWorkTexts(reportId: string) {
    for (const k of [...this.texts.keys()]) if (k.startsWith(`${reportId}:`)) this.texts.delete(k);
  }
  async consumeQuota(
    provider: string,
    resource: string,
    amount: number,
    period: "day" | "month",
    limit: number,
  ) {
    const key = `${provider}|${resource}|${period}`;
    const used = this.quota.get(key) ?? 0;
    const granted = used + amount <= limit;
    if (granted) this.quota.set(key, used + amount);
    this.quotaCalls.push({ provider, resource, amount, granted });
    return granted;
  }
  async quotaUsed(provider: string, resource: string, period: "day" | "month") {
    return this.quota.get(`${provider}|${resource}|${period}`) ?? 0;
  }
  async enqueueJob(job: NewJob) {
    if (
      this.jobs.some(
        (j) => j.scanRunId === job.scanRunId && j.stage === job.stage && j.key === job.key,
      )
    )
      return;
    this.jobs.push({ ...job, id: ++this.seq, status: "queued" });
  }
  async acceptVisitorResearch(input: AcceptVisitor): Promise<AcceptVisitorResult> {
    const open = [...this.reports.values()]
      .filter(
        (r) =>
          r.securityId === input.securityId &&
          (r.status === "queued" || r.status === "running" || r.status === "quota_deferred"),
      )
      .at(-1);
    const source = (value: unknown) =>
      value === "visitor" || value === "owner" || value === "system" ? value : null;
    if (open) {
      return {
        accepted: false,
        startedAt: open.startedAt,
        requestedBy: source(open.usage.source),
      };
    }
    const job = this.jobs.find(
      (j) =>
        j.stage === "research" &&
        j.payload.security_id === input.securityId &&
        j.status === "queued",
    );
    if (job) {
      return { accepted: false, startedAt: null, requestedBy: source(job.payload.source) };
    }
    const sec = this.securities.get(input.securityId);
    const report = await this.createReport({
      idempotencyKey: input.reportKey,
      securityId: input.securityId,
      companyId: sec?.companyId ?? "",
      scanRunId: input.scanRunId,
      trigger: "visitor",
      visibility: "public",
    });
    const stored = this.reports.get(report.id);
    if (stored) {
      stored.startedAt = input.acceptedAt;
      stored.usage = { ...stored.usage, source: "visitor" };
    }
    await this.enqueueJob({ ...input.job, scanRunId: input.scanRunId });
    return { accepted: true, reportId: report.id, startedAt: input.acceptedAt };
  }
  async applyReportToCards(u: CardUpdate) {
    let n = 0;
    for (const c of this.cards) {
      if (c.scanRunId !== u.scanRunId || c.securityId !== u.securityId) continue;
      c.operationalCategory = u.category;
      c.categoryReason = u.reasonCode;
      c.withheld = !(u.category === "green" || u.category === "amber");
      if (u.reportId) c.researchReportId = u.reportId;
      c.summary = u.summary;
      c.conclusion = u.conclusion;
      c.bankruptcyRisk = u.bankruptcyRisk;
      c.completedAt = u.completedAt;
      n++;
    }
    return n;
  }
  async hasPendingCard(scanRunId: string, securityId: string) {
    return this.cards.some(
      (c) =>
        c.scanRunId === scanRunId &&
        c.securityId === securityId &&
        c.operationalCategory === "pending",
    );
  }
  async listCards(scanRunId: string) {
    return this.cards.filter((c) => c.scanRunId === scanRunId).map((c) => ({ ...c }));
  }
  async updateCard(id: number, patch: CardPatch) {
    const c = this.cards.find((x) => x.id === id);
    if (!c) throw new Error(`no card ${id}`);
    c.operationalCategory = patch.category;
    c.categoryReason = patch.reasonCode;
    c.withheld = !(patch.category === "green" || patch.category === "amber");
    c.researchReportId = patch.reportId;
    c.summary = patch.summary;
    c.conclusion = patch.conclusion;
    c.bankruptcyRisk = patch.bankruptcyRisk;
    c.completedAt = patch.completedAt;
    c.displayOrder = patch.displayOrder;
  }
  async updateMonitorReport(securityId: string, reportId: string, category: string) {
    this.monitorReports.set(securityId, { reportId, category });
  }
  async setLatestItems(securityId: string, latest: LatestItems) {
    this.monitorLatest.set(securityId, structuredClone(latest));
  }
  async mergeCoverage(scanRunId: string, patch: Record<string, unknown>) {
    this.coverage.set(scanRunId, { ...(this.coverage.get(scanRunId) ?? {}), ...patch });
  }
  async refreshScanStatus(scanRunId: string) {
    this.refreshed.push(scanRunId);
  }
  async latestScanRun() {
    return this.scanRuns.at(-1) ?? null;
  }
  async latestPublishedRun() {
    return this.scanRuns.find((r) => r.id === this.publishedRunId) ?? null;
  }
  async listPendingDiscountSecurities(scanRunId: string) {
    const ids = new Set(
      this.cards
        .filter(
          (c) =>
            c.scanRunId === scanRunId &&
            c.operationalCategory === "pending" &&
            c.mode === "worldwide",
        )
        .map((c) => c.securityId),
    );
    const out: string[] = [];
    for (const id of ids) if (!(await this.hasInflightReport(id))) out.push(id);
    return out;
  }
  async listPremiumSecurities(scanRunId: string) {
    return this.premium.get(scanRunId) ?? [];
  }
  async listStaleCurrentReports(olderThanIso: string) {
    return [...this.reports.values()]
      .filter((r) => r.isCurrent && r.completedAt !== null && r.completedAt < olderThanIso)
      .map((r) => ({ securityId: r.securityId, reportId: r.id }));
  }
  async listDeferred(nowIso: string) {
    return [...this.reports.values()]
      .filter((r) => r.status === "quota_deferred" && (r.notBefore ?? "") <= nowIso)
      .map((r) => structuredClone(r));
  }
  async failStaleParkedReports() {
    const ids: string[] = [];
    for (const r of this.reports.values()) {
      if (r.trigger === "monitor_first" || r.trigger === "monitor_change") continue;
      if (r.status === "quota_deferred" || (r.status === "queued" && r.waitReason !== null)) {
        r.status = "failed";
        r.error = "reset";
        r.completedAt = new Date().toISOString();
        ids.push(r.id);
      }
    }
    this.jobs = this.jobs.filter(
      (j) =>
        !(
          j.stage === "research" &&
          j.status === "queued" &&
          typeof j.payload.report_id === "string" &&
          ids.includes(j.payload.report_id)
        ),
    );
    return ids.length;
  }
  async exhaustedModels(nowIso: string) {
    this.exhaustedReads++;
    return [...this.exhausted].filter(([, v]) => v.until > nowIso).map(([k]) => k);
  }
  async markModelExhausted(key: string, untilIso: string, error: string) {
    this.exhausted.set(key, { until: untilIso, error });
  }
  async supersedeInflightReports(securityId: string, exceptReportId: string) {
    const ids: string[] = [];
    for (const r of this.reports.values()) {
      if (
        r.securityId === securityId &&
        r.id !== exceptReportId &&
        (r.status === "queued" || r.status === "running" || r.status === "quota_deferred")
      ) {
        r.status = "failed";
        r.error = "superseded";
        ids.push(r.id);
      }
    }
    this.jobs = this.jobs.filter(
      (j) =>
        !(
          j.stage === "research" &&
          j.status === "queued" &&
          typeof j.payload.report_id === "string" &&
          ids.includes(j.payload.report_id)
        ),
    );
    return ids.length;
  }
  async listNewsTargets(scanRunId: string) {
    return [
      ...new Set(this.cards.filter((c) => c.scanRunId === scanRunId).map((c) => c.securityId)),
    ];
  }
}
