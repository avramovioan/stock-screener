import type {
  ResearchBankruptcyRisk,
  ResearchConclusion,
  SourceKind,
  Stage1Fact,
} from "../core/research.ts";
import type { DirectOptions, DocFetchResult } from "./fetchers/direct.ts";
import type { EdgarClient } from "./fetchers/edgar.ts";
import type { JinaOptions, JinaResult } from "./fetchers/jina.ts";
import type { FeedItem } from "./fetchers/rss.ts";
import type { LlmProvider } from "./llm/types.ts";
import type { TavilyClient } from "./search/tavily.ts";

export type ResearchTrigger =
  | "new_discount"
  | "premium"
  | "monitor_first"
  | "monitor_change"
  | "refresh"
  | "manual"
  /** A visitor pressed "Scan with AI" on the public site (Edge Function `research-request`); behaves like `manual`. */
  | "visitor";
export type ReportStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "quota_deferred"
  | "stale";
export type Visibility = "public" | "holders";
export type DeferCode =
  | "llm_quota"
  | "tavily_quota"
  | "daily_cap"
  | "provider_not_configured"
  /** Every LLM provider answered "unavailable" and the bounded backoff is spent: the report waits for the next scan day. */
  | "provider_unavailable";

/** Why a report is waiting (research_reports.wait_reason); the cards turn it into a sentence. Null when nothing waits. */
export type WaitReason =
  | "provider_unavailable"
  | "llm_quota"
  | "search_quota"
  | "rate_limited"
  | "weekend"
  | "cadence_72h";

/** Why the backup model wrote a report (research_reports.fallback_reason). Null when the primary wrote it. */
export type FallbackReason = "primary_unavailable" | "primary_quota" | "primary_rate_limited";

/** Spec 9.8, seeded verbatim into `app_settings.research`. */
export interface ResearchSettings {
  /** null or absent = no daily cap on full reports (owner ruling R6); the Tavily and LLM caps below still apply. */
  max_full_reports_per_day: number | null;
  tavily_daily_cap: number;
  tavily_monthly_budget: number;
  llm_daily_request_cap: number;
  max_change_checks_per_day: number;
  reuse_days: number;
  tavily_reserved_for_reports: number;
  /** Per security: no AI work within this many hours of its last AI activity (report completed or change check run). 1..720. */
  min_recheck_hours: number;
  /** No AI work on Saturday and Sunday (Europe/Sofia); manual research_now is exempt. */
  ai_weekdays_only: boolean;
  /** Visitor "Scan with AI" limits, enforced by the `research-request` function: accepted requests per network and hour. */
  visitor_scans_per_hour_per_ip: number;
  /** Visitor scans accepted per UTC day, all networks together. */
  visitor_scans_per_day: number;
  /** After a failed report, a visitor may start a new scan once this many minutes have passed. */
  visitor_retry_minutes: number;
  /** After a failed report with error `providers_busy` (the free models were overloaded), a visitor may retry after this many minutes. */
  busy_retry_minutes: number;
  /** `app_settings.research.llm_chain`, raw: validated by `parseLlmChain` when the worker builds its providers (absent = the env pair). */
  llm_chain?: unknown;
}

export const MIN_RECHECK_HOURS_BOUNDS = { min: 1, max: 720 } as const;

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  max_full_reports_per_day: null,
  tavily_daily_cap: 32,
  tavily_monthly_budget: 950,
  llm_daily_request_cap: 300,
  max_change_checks_per_day: 40,
  reuse_days: 30,
  tavily_reserved_for_reports: 24,
  min_recheck_hours: 72,
  ai_weekdays_only: true,
  visitor_scans_per_hour_per_ip: 3,
  visitor_scans_per_day: 8,
  visitor_retry_minutes: 60,
  busy_retry_minutes: 15,
};

function parseRecheckHours(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n))
    return DEFAULT_RESEARCH_SETTINGS.min_recheck_hours;
  return Math.min(
    MIN_RECHECK_HOURS_BOUNDS.max,
    Math.max(MIN_RECHECK_HOURS_BOUNDS.min, Math.floor(n)),
  );
}

/** Merges a stored `app_settings.research` value over the defaults; a null or absent report cap means unlimited. */
export function parseResearchSettings(value: unknown): ResearchSettings {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<ResearchSettings>;
  const cap = stored.max_full_reports_per_day;
  return {
    ...DEFAULT_RESEARCH_SETTINGS,
    ...stored,
    max_full_reports_per_day: typeof cap === "number" && Number.isFinite(cap) ? cap : null,
    min_recheck_hours: parseRecheckHours(stored.min_recheck_hours),
    ai_weekdays_only:
      typeof stored.ai_weekdays_only === "boolean"
        ? stored.ai_weekdays_only
        : DEFAULT_RESEARCH_SETTINGS.ai_weekdays_only,
  };
}

/** Public identifiers of one security; nothing here is user data. */
export interface SecurityContext {
  securityId: string;
  companyId: string;
  companyName: string;
  ticker: string;
  primaryExchange: string;
  reportingCurrency: string;
  sector: string | null;
  industry: string | null;
  secCik: string | null;
  irRssUrls: string[];
  newsSymbol: string | null;
}

export interface ReportUsage {
  /** Who asked for this report, copied from the job payload (`visitor` for the public button). */
  source?: string;
  reserved?: Record<string, true>;
  preserve_cards?: boolean;
  tokens?: { input: number; output: number };
  llm_calls?: number;
  queries?: string[];
  queries_done?: number[];
  selected?: number[];
  deterministic?: string;
  industry_note?: string;
  limited_sources?: boolean;
  low_quota_logged?: boolean;
  missing?: string[];
  stage2?: { attempt: 1 | 2; json: unknown } | null;
  synth_attempt?: 1 | 2;
  retry_feedback?: string | null;
  shown_ids?: number[];
  dropped_facts?: number;
  liveness_checks?: number;
  /** Short per-minute 429 retries spent on this report (bounded; then the day-long deferral applies). */
  rate_limit_retries?: number;
  /** Provider-overload backoff retries spent on this report (bounded to 4, separate from `rate_limit_retries`). */
  unavailable_retries?: number;
  /**
   * Chain models whose per-minute retries are spent while this report runs: the walk does not return to them until some other
   * model answers (prevents ping-pong between two limited models).
   */
  rate_limited_models?: string[];
  /** Which provider id ran each LLM step (`extract:1`, `synthesize` ...), in order of execution. */
  step_providers?: Record<string, string>;
}

export interface ReportRow {
  id: string;
  securityId: string;
  companyId: string;
  scanRunId: string | null;
  trigger: ResearchTrigger;
  status: ReportStatus;
  step: string | null;
  notBefore: string | null;
  isCurrent: boolean;
  visibility: Visibility;
  reportMd: string | null;
  summary: string | null;
  newsSummary: string | null;
  conclusion: ResearchConclusion | null;
  bankruptcyRisk: ResearchBankruptcyRisk | null;
  materialDamageEstablished: boolean | null;
  sufficientEvidence: boolean | null;
  citedEvidenceIds: number[];
  claims: unknown;
  missingDocuments: string[];
  limitations: string[];
  researchCutoffDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  /** Provenance for the cards (migration 20261015007900). `provider`/`model` above hold the WRITER of the report text. */
  fallbackReason: FallbackReason | null;
  waitReason: WaitReason | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  /** Model id the next try will use (the web app derives its display name). */
  nextProvider: string | null;
  /** True when the backup model wrote the report from a trimmed evidence set (migration 20261015008300); null otherwise. */
  evidenceTrimmed: boolean | null;
  usage: ReportUsage;
  queriesUsed: number;
  docsFetched: number;
  error: string | null;
  supersedesId: string | null;
  idempotencyKey: string;
  updatedAt: string | null; // research_reports.updated_at, read by the stale-running guard of classify:final
}

export type ReportPatch = Partial<
  Omit<ReportRow, "id" | "idempotencyKey" | "securityId" | "companyId">
>;

export interface NewReport {
  idempotencyKey: string;
  securityId: string;
  companyId: string;
  scanRunId: string | null;
  trigger: ResearchTrigger;
  visibility: Visibility;
}

/** Accepting a visitor request: the queued report and the research job are created together, once per company at a time. */
export interface AcceptVisitor {
  securityId: string;
  scanRunId: string;
  /** Accepted time: the report's `started_at`, and the clock the feed shows as the scan's start. */
  acceptedAt: string;
  reportKey: string;
  job: Omit<NewJob, "scanRunId">;
}

export type AcceptVisitorResult =
  | { accepted: true; reportId: string; startedAt: string }
  | {
      accepted: false;
      /** Start (or queue) time of the scan already in flight, who asked for it (feed mapping). */
      startedAt: string | null;
      requestedBy: "visitor" | "owner" | "system" | null;
    };

export interface SourceMeta {
  form?: string;
  accession?: string;
  query?: string;
  dateSource?: string;
  extracted?: boolean;
  fetch_error?: string;
}

export interface SourceRow {
  reportId: string;
  evidenceId: number;
  url: string;
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  kind: SourceKind;
  publishedAt: string | null;
  filingDate: string | null;
  retrievedAt: string | null;
  httpStatus: number | null;
  contentType: string | null;
  contentHash: string | null;
  excerpt: string | null;
  extracted: Stage1Fact[];
  livenessVerifiedAt: string | null;
  verification: "pending" | "ok" | "failed" | "skipped";
  usedInReport: boolean;
  meta: SourceMeta;
}

export type NewSource = Pick<
  SourceRow,
  | "url"
  | "canonicalUrl"
  | "title"
  | "publisher"
  | "kind"
  | "publishedAt"
  | "filingDate"
  | "excerpt"
  | "meta"
>;
export type SourcePatch = Partial<Omit<SourceRow, "reportId" | "evidenceId">>;

export interface NewJob {
  scanRunId: string;
  stage: "research" | "news" | "classify" | "publish";
  key: string;
  payload: Record<string, unknown>;
  priority?: number;
  notBefore?: string;
}

export interface CardRow {
  id: number;
  mode: string;
  securityId: string;
  rank: number;
  symbol: string;
  researchReportId: string | null;
  operationalCategory: string;
}

export interface CardUpdate {
  scanRunId: string;
  securityId: string;
  reportId: string | null;
  category: string;
  reasonCode: string;
  summary: string | null;
  conclusion: string | null;
  bankruptcyRisk: string | null;
  completedAt: string | null;
}

export interface CardPatch extends Omit<CardUpdate, "scanRunId" | "securityId"> {
  displayOrder: number;
}

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  form?: string;
}

/** Items the `news` stage saw today; the change check compares them with what it has already acknowledged. */
export interface LatestItems {
  yahoo: NewsItem[];
  edgar: NewsItem[];
  rss: NewsItem[];
}

export interface ResearchStore {
  loadSecurity(securityId: string): Promise<SecurityContext | null>;
  saveSecCik(companyId: string, cik: string): Promise<void>;
  hasDiscountCard(securityId: string): Promise<boolean>;
  findReportByKey(key: string): Promise<ReportRow | null>;
  createReport(input: NewReport): Promise<ReportRow>;
  getReport(id: string): Promise<ReportRow | null>;
  patchReport(id: string, patch: ReportPatch): Promise<void>;
  deleteReport(id: string): Promise<void>;
  currentReport(securityId: string): Promise<ReportRow | null>;
  /** A report that runs, is deferred, or waits for a weekend or cadence slot (queued with a wait reason). */
  hasInflightReport(securityId: string): Promise<boolean>;
  /** Any report that is queued (waiting or not), running or deferred: the card's research is under way. */
  hasActiveReport(securityId: string): Promise<boolean>;
  /** Completion time of the newest complete report of the security (any trigger); the cadence counts from it. */
  lastReportCompletedAt(securityId: string): Promise<string | null>;
  /**
   * Securities whose card in this run continues an earlier discount episode (not a new one) and has a complete report:
   * they get a change check every `min_recheck_hours` instead of a new report. One ranking, worldwide: only the
   * worldwide-mode rows count.
   */
  listPersistingDiscounts(scanRunId: string): Promise<string[]>;
  hasAnyReport(securityId: string): Promise<boolean>;
  hasOpenFindingSince(securityId: string, sinceIso: string): Promise<boolean>;
  promoteReport(reportId: string): Promise<string | null>;
  listSources(reportId: string): Promise<SourceRow[]>;
  addSources(reportId: string, rows: NewSource[]): Promise<SourceRow[]>;
  patchSource(reportId: string, evidenceId: number, patch: SourcePatch): Promise<void>;
  clearSources(reportId: string): Promise<void>;
  putWorkText(reportId: string, evidenceId: number, text: string): Promise<void>;
  getWorkText(reportId: string, evidenceId: number): Promise<string | null>;
  deleteWorkTexts(reportId: string): Promise<void>;
  consumeQuota(
    provider: string,
    resource: string,
    amount: number,
    period: "day" | "month",
    limit: number,
  ): Promise<boolean>;
  quotaUsed(provider: string, resource: string, period: "day" | "month"): Promise<number>;
  enqueueJob(job: NewJob): Promise<void>;
  /** Atomic single flight (SQL `accept_visitor_research`): creates the queued visitor report and its job, or names the scan in flight. */
  acceptVisitorResearch(input: AcceptVisitor): Promise<AcceptVisitorResult>;
  applyReportToCards(update: CardUpdate): Promise<number>;
  hasPendingCard(scanRunId: string, securityId: string): Promise<boolean>;
  listCards(scanRunId: string): Promise<CardRow[]>;
  updateCard(id: number, patch: CardPatch): Promise<void>;
  updateMonitorReport(securityId: string, reportId: string, category: string): Promise<void>;
  setLatestItems(securityId: string, latest: LatestItems): Promise<void>;
  mergeCoverage(scanRunId: string, patch: Record<string, unknown>): Promise<void>;
  refreshScanStatus(scanRunId: string): Promise<void>;
  latestScanRun(): Promise<{ id: string; scanDateLocal: string } | null>;
  /** The newest scan run (by `results_published_at`) whose results are published; null before the first publication. */
  latestPublishedRun(): Promise<{ id: string; scanDateLocal: string } | null>;
  /**
   * Pending discount candidates of a run that no report is in flight for. One ranking, worldwide: every candidate of the
   * worldwide mode is researched; "us" is only a view filter and drives no research.
   */
  listPendingDiscountSecurities(scanRunId: string): Promise<string[]>;
  listPremiumSecurities(scanRunId: string): Promise<string[]>;
  listStaleCurrentReports(
    olderThanIso: string,
  ): Promise<{ securityId: string; reportId: string }[]>;
  listDeferred(nowIso: string): Promise<ReportRow[]>;
  /**
   * Resets reports the old worker parked (`quota_deferred`, or `queued` with a `wait_reason`) whose trigger is not
   * `monitor_first` / `monitor_change`: they become `failed` with `error = 'reset'`, and their open `research` jobs are deleted.
   * Returns how many reports were reset.
   */
  failStaleParkedReports(): Promise<number>;
  /** Chain model keys whose per-day quota is used up: `llm_model_state.exhausted_until > nowIso`. Read once per step. */
  exhaustedModels(nowIso: string): Promise<string[]>;
  /** Upserts `llm_model_state` (service role): the model answered a per-day quota error and is skipped until `untilIso`. */
  markModelExhausted(key: string, untilIso: string, error: string): Promise<void>;
  /**
   * A report of the security just completed: every other `queued`, `running` or `quota_deferred` report of it becomes `failed`
   * with `error = 'superseded'` and its open `research` scan jobs are deleted. Returns the number of reports superseded.
   */
  supersedeInflightReports(securityId: string, exceptReportId: string): Promise<number>;
  listNewsTargets(scanRunId: string): Promise<string[]>;
}

export interface YahooNewsItem {
  uuid: string;
  title: string;
  publisher?: string | undefined;
  link: string;
  providerPublishTime: Date | string;
  relatedTickers?: string[] | undefined;
}

export interface FetchPort {
  direct(url: string, opts?: DirectOptions): Promise<DocFetchResult>;
  jina(url: string, opts?: JinaOptions): Promise<JinaResult>;
  feed(
    url: string,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<{ ok: true; items: FeedItem[] } | { ok: false; message: string }>;
}

export interface Job {
  id: number | string;
  scan_run_id: string;
  stage: string;
  key: string;
  payload: Record<string, unknown>;
  attempts?: number;
  max_attempts?: number;
}

export interface HandlerCtx {
  signal: AbortSignal;
  /** `performance.now()` value at which the invocation must have finished (spec 7.5). */
  deadline: number;
}

export interface ResearchDeps {
  store: ResearchStore;
  llm: Record<string, LlmProvider>;
  /** Chain model keys in order, first model first (the env pair when no `llm_chain` is set). */
  llmOrder: string[];
  tavily: TavilyClient;
  fetch: FetchPort;
  edgar: EdgarClient;
  yahooNews: (symbol: string) => Promise<YahooNewsItem[]>;
  settings: () => Promise<ResearchSettings>;
  now: () => Date;
  sha256: (text: string) => Promise<string>;
  log: (
    event: string,
    data?: Record<string, unknown>,
    ctx?: { scanRunId?: string; securityId?: string; level?: "info" | "warn" | "error" },
  ) => Promise<void>;
  secUserAgent: string;
  jinaApiKey?: string | undefined;
  /** Registered by Task 6: the daily change-check job (`payload.kind = "change_check"`). */
  changeCheck?: ((job: Job, ctx: HandlerCtx) => Promise<unknown>) | undefined;
  /** Registered by Task 6: extra jobs the stage 10 seeder adds (change checks, monitor_first). */
  seedExtras?: ((scanRunId: string, scanDateLocal: string) => Promise<number>) | undefined;
}
