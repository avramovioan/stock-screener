import type { Filing } from "../../_shared/adapters/fetchers/edgar.ts";
import { canonicalUrl, capText } from "../../_shared/adapters/fetchers/extract.ts";
import type {
  GenerateJsonRequest,
  JsonSchema,
  LlmProvider,
  QuotaReset,
} from "../../_shared/adapters/llm/types.ts";
import type {
  DeferCode,
  FallbackReason,
  HandlerCtx,
  Job,
  NewSource,
  ReportPatch,
  ReportRow,
  ResearchDeps,
  ResearchSettings,
  ResearchTrigger,
  SecurityContext,
  SourceRow,
  Visibility,
  WaitReason,
} from "../../_shared/adapters/research_types.ts";
import { aiGate } from "../../_shared/core/cadence.ts";
import { classifyOperational } from "../../_shared/core/classify.ts";
import { charsLeft, type StepBudget, stepBudget } from "../../_shared/core/llm-budget.ts";
import {
  ANNUAL_FORMS,
  buildStage1User,
  buildStage2User,
  dateLabel,
  EVIDENCE_PREAMBLE,
  fitEvidence,
  hostOf,
  INTERIM_FORMS,
  industryKind,
  industryNote,
  isIrUrl,
  type LedgerEntry,
  PROMPT_VERSION,
  type PromptVars,
  pickFilings,
  queryTemplates,
  type RankCandidate,
  RESEARCH_OUTPUT_SCHEMA,
  type ResearchOutput,
  rankDocuments,
  renderFilingList,
  renderSources,
  SCHEMA_VERSION,
  STAGE1_OUTPUT_SCHEMA,
  STAGE1_SYSTEM,
  STAGE2_EVIDENCE_MAX_CHARS,
  selectDocuments,
  validateResearchOutput,
  validateStage1Facts,
} from "../../_shared/core/research.ts";

export const STEP_ORDER = [
  "plan",
  "prefetch",
  "search:1",
  "search:2",
  "fetch:1",
  "fetch:2",
  "fetch:3",
  "extract:1",
  "extract:2",
  "extract:3",
  "extract:4",
  "synthesize",
  "validate",
] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** Lower runs first (`scan_jobs.priority`); spec 9.1: discount > premium > monitor_first > monitor_change > refresh. */
export const TRIGGER_PRIORITY: Record<ResearchTrigger, number> = {
  manual: 5,
  visitor: 5,
  new_discount: 10,
  premium: 20,
  monitor_first: 30,
  monitor_change: 40,
  refresh: 90,
};

/** manual and visitor requests always write a fresh report: the cooldown that limits them is the caller's job. */
const REUSE_TRIGGERS = new Set<ResearchTrigger>(["new_discount", "premium", "monitor_first"]);
/** Triggers whose report must never downgrade the card the user already sees while it runs or fails (A-27). */
const PRESERVE_TRIGGERS = new Set<ResearchTrigger>([
  "refresh",
  "monitor_change",
  "manual",
  "visitor",
]);
const REPORT_CLASS: Record<ResearchTrigger, string> = {
  new_discount: "discount",
  premium: "premium",
  monitor_first: "monitor",
  monitor_change: "monitor",
  refresh: "refresh",
  manual: "manual",
  visitor: "manual",
};
const MIN_DOC_CHARS = 200;
const MAX_DOC_CHARS = 48_000;
const STEP_MIN_MS = 25_000;
const AUX_CAPS = { jina: 200, sec: 5000 } as const;

export type StepOutcome =
  | { kind: "next"; step: StepName; reportId: string; suffix?: string }
  | { kind: "again"; reportId: string; notBefore?: string }
  | { kind: "retry_synthesize"; reportId: string }
  /** Weekend or cadence wait: a side-channel job (payload.late) runs `step` at `notBefore`, outside the scan run. */
  | { kind: "late"; reportId: string; step: string; notBefore: string }
  | {
      kind: "done";
      status: "complete" | "failed" | "deferred" | "reused";
      reportId: string | null;
    };

export interface ChainPayload {
  security_id: string;
  trigger: ResearchTrigger;
  scan_run_id: string;
  scan_date_local: string;
  report_id: string | null;
  step: string;
  n: number;
  force: boolean;
  /** Visitor requests: the accepted minute (ISO), part of the report's idempotency key so a failed report never blocks the next. */
  accepted_at: string | null;
  /** Who asked, copied into `usage.source` of the report. */
  source: string | null;
  /** A side-channel job that waited for a weekend or cadence slot: it never keeps its scan run open. Propagates to follow-ups. */
  late: boolean;
}

export function parsePayload(raw: Record<string, unknown>, job: Job): ChainPayload {
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const trigger = str("trigger") as ResearchTrigger;
  if (!(trigger in TRIGGER_PRIORITY)) throw new Error(`invalid research trigger "${trigger}"`);
  const securityId = str("security_id");
  if (securityId === "") throw new Error("research job without security_id");
  const scanDate = str("scan_date_local");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate))
    throw new Error(`invalid scan_date_local "${scanDate}"`);
  return {
    security_id: securityId,
    trigger,
    scan_run_id: job.scan_run_id,
    scan_date_local: scanDate,
    report_id: str("report_id") || null,
    step: str("step") || "plan",
    n: Number(raw.n ?? 0) || 0,
    force: raw.force === true,
    accepted_at: str("accepted_at") || null,
    source: str("source") || null,
    late: raw.late === true,
  };
}

interface Env {
  deps: ResearchDeps;
  job: Job;
  ctx: HandlerCtx;
  p: ChainPayload;
  settings: ResearchSettings;
  security: SecurityContext;
  report: ReportRow;
  provider: LlmProvider | null;
  /** Chain model keys whose per-day quota is used up; read from `llm_model_state` once per step (see `exhaustedSet`). */
  exhausted?: Set<string>;
}

// ---------------------------------------------------------------- small helpers

export function nextUtcDayPlus(now: Date, minutes = 5): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, minutes),
  ).toISOString();
}

const LA_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
});

function laClock(ms: number): { y: number; m: number; d: number; h: number } {
  const n = (type: string): number =>
    Number(LA_PARTS.formatToParts(new Date(ms)).find((x) => x.type === type)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), h: n("hour") };
}

/**
 * The next per-day quota reset after `now`: 00:00 America/Los_Angeles (Gemini) or 00:00 UTC (Groq), as an ISO instant.
 * Pacific is DST-safe: the midnight of the next Los Angeles date is whichever of UTC-7 (PDT) or UTC-8 (PST) lands on 00:00 there.
 */
export function nextQuotaReset(now: Date, mode: QuotaReset): string {
  if (mode === "utc") return nextUtcDayPlus(now, 0);
  const la = laClock(now.getTime());
  const next = new Date(Date.UTC(la.y, la.m - 1, la.d + 1));
  for (const offset of [7, 8]) {
    const t = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), offset);
    const c = laClock(t);
    if (c.h === 0 && c.d === next.getUTCDate() && c.m === next.getUTCMonth() + 1)
      return new Date(t).toISOString();
  }
  throw new Error("no Pacific midnight found"); // unreachable: every Los Angeles date has a midnight at UTC-7 or UTC-8
}

export function ageDays(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 86_400_000;
}

/** A current public report within the reuse window may be linked instead of regenerated (spec 9.11). */
export function isReusable(
  cur: ReportRow,
  trigger: ResearchTrigger,
  settings: ResearchSettings,
  now: Date,
): boolean {
  return (
    cur.status === "complete" &&
    cur.completedAt !== null &&
    ageDays(cur.completedAt, now) <= settings.reuse_days &&
    (trigger !== "new_discount" || cur.visibility === "public")
  );
}

export function toFacts(r: ReportRow | null) {
  return r
    ? {
        status: r.status,
        conclusion: r.conclusion,
        bankruptcyRisk: r.bankruptcyRisk,
        materialDamageEstablished: r.materialDamageEstablished,
        sufficientEvidence: r.sufficientEvidence,
      }
    : null;
}

/** US-style ticker (no exchange suffix) usable with EDGAR and Yahoo news, else the ADR line, else null (spec 5.10). */
export function secTicker(sec: SecurityContext): string | null {
  const own = sec.ticker.toUpperCase();
  if (/^[A-Z]{1,5}([-.][A-Z])?$/.test(own)) return own.replace(".", "-");
  return sec.newsSymbol ? sec.newsSymbol.toUpperCase() : null;
}

const toIso = (date: string | undefined): string | null => {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const dedupe = (items: string[]): string[] => [...new Set(items.filter((s) => s.trim() !== ""))];

async function save(env: Env, patch: ReportPatch = {}): Promise<void> {
  Object.assign(env.report, patch);
  await env.deps.store.patchReport(env.report.id, { ...patch, usage: env.report.usage });
}

function addLimitation(env: Env, code: string): void {
  if (!env.report.limitations.includes(code))
    env.report.limitations = [...env.report.limitations, code];
}

async function applyCards(env: Env, r: ReportRow = env.report): Promise<void> {
  if (env.report.usage.preserve_cards === true && r.status !== "complete") return;
  // a holders-only report is never linked to (or copied onto) a public card
  if (r.visibility !== "public") return;
  const { category, reasonCode } = classifyOperational(toFacts(r));
  const update = {
    scanRunId: env.job.scan_run_id,
    securityId: env.security.securityId,
    reportId: r.id,
    category,
    reasonCode,
    summary: r.summary,
    conclusion: r.conclusion,
    bankruptcyRisk: r.bankruptcyRisk,
    completedAt: r.completedAt,
  };
  await env.deps.store.applyReportToCards(update);
  // Late research (a side-channel job after a weekend or cadence wait) may finish after a newer scan published its own cards:
  // those cards show the result too, without a second digest (the digest only ever picks up cards that finished in time).
  if (env.p.late) {
    const latest = await env.deps.store.latestScanRun();
    if (latest && latest.id !== env.job.scan_run_id)
      await env.deps.store.applyReportToCards({ ...update, scanRunId: latest.id });
  }
}

const WAIT_OF_DEFER: Record<DeferCode, WaitReason | null> = {
  llm_quota: "llm_quota",
  tavily_quota: "search_quota",
  daily_cap: null,
  provider_not_configured: null,
  provider_unavailable: "provider_unavailable",
};

/** Model id the next try is expected to use: the report's current provider, else the primary. */
function nextModel(env: Env): string | null {
  if (env.provider) return env.provider.model;
  const live = env.deps.llmOrder
    .map((name) => env.deps.llm[name])
    .filter((p): p is LlmProvider => p !== undefined && p.configured);
  const first = live.find((p) => !env.exhausted?.has(p.name)) ?? live[0];
  return first?.model ?? env.deps.llm[env.deps.llmOrder[0] ?? ""]?.model ?? null;
}

/** Chain models whose per-day quota is used up, read once per step and kept on the step's env. */
async function exhaustedSet(env: Env): Promise<Set<string>> {
  env.exhausted ??= new Set(await env.deps.store.exhaustedModels(env.deps.now().toISOString()));
  return env.exhausted;
}

/** True when every configured chain model is out of quota for the day (and at least one is configured). */
function allExhausted(env: Env): boolean {
  const live = env.deps.llmOrder
    .map((name) => env.deps.llm[name])
    .filter((p): p is LlmProvider => p !== undefined && p.configured);
  return live.length > 0 && live.every((p) => env.exhausted?.has(p.name) === true);
}

/** Visitor and manual reports are never parked: they end `failed` and the visitor asks again later. */
const PARKING_TRIGGERS = new Set<ResearchTrigger>(["monitor_first", "monitor_change"]);

/** Wait fields shown on the card: why, when we last tried, when we try next and on which model. All null when nothing waits. */
function waitPatch(env: Env, reason: WaitReason | null, nextAttemptAt: string): ReportPatch {
  return reason === null
    ? { waitReason: null, lastAttemptAt: null, nextAttemptAt: null, nextProvider: null }
    : {
        waitReason: reason,
        lastAttemptAt: env.deps.now().toISOString(),
        nextAttemptAt,
        nextProvider: nextModel(env),
      };
}

/**
 * The terminal code of a report that may not wait: `no_quota` when the free quota of the day is spent (every model, or Tavily),
 * `providers_busy` when the chain was walked and only overload or per-minute limits stopped it, else the defer code itself.
 */
async function failInsteadOfDefer(env: Env, code: DeferCode, step: string): Promise<StepOutcome> {
  await exhaustedSet(env);
  const error =
    code === "tavily_quota"
      ? "no_quota"
      : code === "provider_unavailable"
        ? "providers_busy"
        : code === "llm_quota"
          ? allExhausted(env)
            ? "no_quota"
            : "providers_busy"
          : code;
  env.report.step = step;
  return await failReport(env, error);
}

async function defer(env: Env, code: DeferCode, step: string): Promise<StepOutcome> {
  if (!PARKING_TRIGGERS.has(env.p.trigger)) return await failInsteadOfDefer(env, code, step);
  const notBefore = nextUtcDayPlus(env.deps.now());
  await save(env, {
    status: "quota_deferred",
    step,
    error: code,
    notBefore,
    ...waitPatch(env, WAIT_OF_DEFER[code], notBefore),
  });
  await applyCards(env);
  await env.deps.log(
    "research_quota_deferred",
    { report_id: env.report.id, step, code },
    scope(env, "warn"),
  );
  return { kind: "done", status: "deferred", reportId: env.report.id };
}

const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 90_000;

/**
 * A per-minute 429 clears in seconds: re-run the same step soon (bounded), instead of parking the report for a day.
 * `reason` is the wait the card shows ("rate_limited" for the LLM; null for Tavily, whose 90 s pause is not worth a card line).
 */
async function rateLimitRetry(
  env: Env,
  step: string,
  reason: WaitReason | null = "rate_limited",
): Promise<StepOutcome | null> {
  const used = env.report.usage.rate_limit_retries ?? 0;
  if (used >= RATE_LIMIT_RETRIES) return null;
  env.report.usage.rate_limit_retries = used + 1;
  const notBefore = new Date(env.deps.now().getTime() + RATE_LIMIT_DELAY_MS).toISOString();
  await save(env, { step, ...waitPatch(env, reason, notBefore) });
  await env.deps.log(
    "research_rate_limited",
    { report_id: env.report.id, step, retry: used + 1 },
    scope(env, "warn"),
  );
  return {
    kind: "again",
    reportId: env.report.id,
    notBefore,
  };
}

const UNAVAILABLE_BACKOFF_MINUTES = [3, 10, 30, 60] as const;

/**
 * Every provider answered "unavailable" for this step: retry the same step with a growing pause (bounded per report,
 * counted apart from the 429 retries) without consuming a job attempt (the follow-up is a new job). Spent: the report waits for the
 * next scan day with reason provider_unavailable (never dead or failed).
 */
async function unavailableBackoff(env: Env, step: string): Promise<StepOutcome> {
  if (!PARKING_TRIGGERS.has(env.p.trigger)) return await defer(env, "provider_unavailable", step);
  const used = env.report.usage.unavailable_retries ?? 0;
  const minutes = UNAVAILABLE_BACKOFF_MINUTES[used];
  if (minutes === undefined) return await defer(env, "provider_unavailable", step);
  env.report.usage.unavailable_retries = used + 1;
  const notBefore = new Date(env.deps.now().getTime() + minutes * 60_000).toISOString();
  await save(env, { step, ...waitPatch(env, "provider_unavailable", notBefore) });
  await env.deps.log(
    "research_provider_unavailable",
    { report_id: env.report.id, step, retry: used + 1, minutes },
    scope(env, "warn"),
  );
  return { kind: "again", reportId: env.report.id, notBefore };
}

/**
 * The next chain model to try: configured, not the current one, not tried in this call, not out of quota for the day and not
 * one whose per-minute retries this report already spent. Chain order; null when the walk is over.
 */
function otherProvider(env: Env, tried: ReadonlySet<string>): LlmProvider | null {
  const spent = env.report.usage.rate_limited_models ?? [];
  for (const name of env.deps.llmOrder) {
    const p = env.deps.llm[name];
    if (
      p?.configured &&
      p.name !== env.provider?.name &&
      !tried.has(p.name) &&
      !spent.includes(p.name) &&
      env.exhausted?.has(p.name) !== true
    )
      return p;
  }
  return null;
}

/** A per-day quota answer: the model is skipped by every report until its own reset (Pacific midnight or UTC midnight). */
async function markExhausted(env: Env, provider: LlmProvider, message: string): Promise<void> {
  const until = nextQuotaReset(env.deps.now(), provider.quotaReset ?? "utc");
  await env.deps.store.markModelExhausted(provider.name, until, message.slice(0, 300));
  (await exhaustedSet(env)).add(provider.name);
  await env.deps.log(
    "llm_model_exhausted",
    { report_id: env.report.id, model: provider.name, until },
    scope(env, "warn"),
  );
}

/** True for the primary provider (first in the order): only a primary that hands over is a "fallback". */
const isPrimary = (env: Env, p: LlmProvider | null): boolean =>
  p !== null && env.deps.llmOrder[0] === p.name;

/** The report continues on `alt` from now on (it is the writer unless a later step changes it back, which never happens). */
async function switchProvider(env: Env, alt: LlmProvider, reason: FallbackReason): Promise<void> {
  const fromPrimary = isPrimary(env, env.provider);
  await env.deps.log(
    "llm_fallback",
    { report_id: env.report.id, from: env.provider?.name ?? null, to: alt.name, reason },
    scope(env, "warn"),
  );
  env.provider = alt;
  await save(env, {
    provider: alt.name,
    model: alt.model,
    // the backup holds the report from now on (reason shown); a step handed back to the primary makes the primary the writer again
    ...(isPrimary(env, alt)
      ? { fallbackReason: null }
      : fromPrimary
        ? { fallbackReason: reason }
        : {}),
  });
}

async function failReport(env: Env, code: string): Promise<StepOutcome> {
  await save(env, {
    status: "failed",
    error: code,
    completedAt: null,
    ...waitPatch(env, null, ""),
  });
  await env.deps.store.deleteWorkTexts(env.report.id);
  await applyCards(env);
  await env.deps.log("research_failed", { report_id: env.report.id, code }, scope(env, "error"));
  return { kind: "done", status: "failed", reportId: env.report.id };
}

const scope = (env: Env, level: "info" | "warn" | "error" = "info") => ({
  scanRunId: env.job.scan_run_id,
  securityId: env.security.securityId,
  level,
});

function next(env: Env, from: string, suffix?: string): StepOutcome {
  if (from === "search:1" && env.report.usage.limited_sources) {
    return { kind: "next", step: "fetch:1", reportId: env.report.id };
  }
  const following = STEP_ORDER[STEP_ORDER.indexOf(from as StepName) + 1];
  if (!following) throw new Error(`no step after ${from}`);
  return { kind: "next", step: following, reportId: env.report.id, ...(suffix ? { suffix } : {}) };
}

// ---------------------------------------------------------------- quota

interface QuotaSpec {
  provider: string;
  resource: string;
  period: "day" | "month";
  limit: number;
}

async function consumeAll(env: Env, specs: QuotaSpec[]): Promise<boolean> {
  for (const s of specs) {
    if (!(await env.deps.store.consumeQuota(s.provider, s.resource, 1, s.period, s.limit)))
      return false;
  }
  return true;
}

/** Reserves once per report and flag, so a re-delivered step never double-counts. */
async function reserveOnce(env: Env, flag: string, specs: QuotaSpec[]): Promise<boolean> {
  env.report.usage.reserved ??= {};
  const reserved = env.report.usage.reserved;
  if (reserved[flag]) return true;
  if (!(await consumeAll(env, specs))) return false;
  reserved[flag] = true;
  await save(env);
  return true;
}

/** Report searches count against the reserved-for-reports bucket and the overall daily and monthly caps. */
export function tavilySpecs(s: ResearchSettings, forReport: boolean): QuotaSpec[] {
  return [
    ...(forReport
      ? [
          {
            provider: "tavily",
            resource: "credits_report",
            period: "day" as const,
            limit: s.tavily_reserved_for_reports,
          },
        ]
      : []),
    { provider: "tavily", resource: "credits", period: "day", limit: s.tavily_daily_cap },
    { provider: "tavily", resource: "credits", period: "month", limit: s.tavily_monthly_budget },
  ];
}

/** The first chain model that can take a NEW report: configured, not out of quota for the day, under 90% of its request cap. */
export async function chooseProvider(
  deps: ResearchDeps,
  settings: ResearchSettings,
  exhausted?: ReadonlySet<string>,
): Promise<LlmProvider | null> {
  return (await chooseProviderWithReason(deps, settings, exhausted)).provider;
}

/** As `chooseProvider`, plus why a later model was chosen: "primary_quota" when the first is spent or near its cap, null for a setup choice. */
export async function chooseProviderWithReason(
  deps: ResearchDeps,
  settings: ResearchSettings,
  exhausted?: ReadonlySet<string>,
): Promise<{ provider: LlmProvider | null; reason: FallbackReason | null }> {
  const providers = deps.llmOrder
    .map((name) => deps.llm[name])
    .filter((p): p is LlmProvider => p !== undefined);
  const first = providers[0];
  if (!first) return { provider: null, reason: null };
  const spent = exhausted ?? new Set(await deps.store.exhaustedModels(deps.now().toISOString()));
  const live = providers.filter((p) => p.configured && !spent.has(p.name));
  for (const p of live) {
    const used = await deps.store.quotaUsed(p.name, "llm_requests", "day");
    if (used >= 0.9 * settings.llm_daily_request_cap) {
      if (p === first)
        await deps.log("llm_error", {
          reason: "primary_near_daily_cap",
          used,
          cap: settings.llm_daily_request_cap,
        });
      continue;
    }
    return { provider: p, reason: p !== first && first.configured ? "primary_quota" : null };
  }
  // every live model is near its cap: the first still answers until the ledger refuses it, then the walk moves on
  const head = live[0];
  return {
    provider: head ?? null,
    reason: head && head !== first && first.configured ? "primary_quota" : null,
  };
}

/** A request sized for the provider that will receive it; `trimmed` = the budget cut evidence or document text. */
interface BuiltRequest {
  req: Omit<GenerateJsonRequest, "signal" | "schema" | "maxOutputTokens"> & { schema: JsonSchema };
  trimmed: boolean;
}

type LlmOutcome =
  | { ok: true; json: unknown; trimmed: boolean }
  | { ok: false; defer: DeferCode }
  | { ok: false; rateLimited: true }
  /** Every configured provider answered "unavailable": the caller backs off (bounded) without using a job attempt. */
  | { ok: false; unavailable: true }
  /** `tooLarge`: the request itself exceeded the provider's size limit, even after one retry with half the input. */
  | { ok: false; invalid: string; tooLarge?: true };

/**
 * Reserves quota, calls the model, accounts tokens and maps failures (spec 9.8). http/network throw so the worker retries.
 * An "unavailable" answer (overload) or the primary's daily quota hands THIS step to the other configured provider at once;
 * the report then continues on it (provider/model become the writer, fallback_reason records why).
 */
async function callLlm(
  env: Env,
  step: string,
  defaultOutputTokens: number,
  build: (budget: StepBudget) => BuiltRequest,
): Promise<LlmOutcome> {
  const tried = new Set<string>();
  await exhaustedSet(env);
  if (!env.provider?.configured || env.exhausted?.has(env.provider.name)) {
    // the stored model is gone from the chain, unconfigured, or spent for the day: start at the first usable one
    const chosen = await chooseProviderWithReason(env.deps, env.settings, env.exhausted);
    if (chosen.provider && chosen.provider !== env.provider) {
      env.provider = chosen.provider;
      await save(env, { provider: chosen.provider.name, model: chosen.provider.model });
    }
  }
  let unavailable = false;
  // The provider that already answered "request too large" once: it gets ONE retry with half the input, then the step fails.
  let halvedOn: string | null = null;
  for (;;) {
    const provider = env.provider;
    if (!provider?.configured) return { ok: false, defer: "provider_not_configured" };
    tried.add(provider.name);
    const granted = await env.deps.store.consumeQuota(
      provider.name,
      "llm_requests",
      1,
      "day",
      env.settings.llm_daily_request_cap,
    );
    if (!granted) {
      // the request cap of the day is spent for this model: it counts as out of quota for the terminal decision (memory only)
      env.exhausted?.add(provider.name);
      const alt = otherProvider(env, tried);
      if (alt) {
        await switchProvider(env, alt, "primary_quota");
        continue;
      }
      return unavailable ? { ok: false, unavailable: true } : { ok: false, defer: "llm_quota" };
    }
    // Sized per provider: the primary gets the step's full request, a provider with a budget (Groq free tier) a trimmed one.
    const budget = stepBudget(
      provider.budget,
      defaultOutputTokens,
      halvedOn === provider.name ? 1 : 0,
    );
    const built = build(budget);
    const res = await provider.generateJson<unknown>({
      ...built.req,
      maxOutputTokens: budget.maxOutputTokens,
      signal: env.ctx.signal,
    });
    const usage = env.report.usage;
    usage.llm_calls = (usage.llm_calls ?? 0) + 1;
    if (res.ok) {
      usage.tokens = {
        input: (usage.tokens?.input ?? 0) + res.usage.input,
        output: (usage.tokens?.output ?? 0) + res.usage.output,
      };
      usage.step_providers = { ...usage.step_providers, [step]: provider.name };
      // a per-minute budget is spent by every request, so 429 retries count consecutive 429s, not the whole report
      if (provider.budget) usage.rate_limit_retries = 0;
      delete usage.rate_limited_models;
      return { ok: true, json: res.json, trimmed: built.trimmed };
    }
    await env.deps.log(
      "llm_error",
      {
        kind: res.kind,
        status: res.status ?? null,
        provider: provider.name,
        ...(res.tooLarge ? { too_large: true, halved: halvedOn === provider.name } : {}),
      },
      scope(env, "warn"),
    );
    if (res.tooLarge) {
      if (halvedOn !== provider.name) {
        halvedOn = provider.name;
        continue;
      }
      return { ok: false, invalid: res.message, tooLarge: true };
    }
    if (res.kind === "unavailable" || res.kind === "network") {
      unavailable = true;
      const alt = otherProvider(env, tried);
      if (!alt) return { ok: false, unavailable: true };
      await switchProvider(env, alt, "primary_unavailable");
      continue;
    }
    if (res.kind === "quota") {
      await markExhausted(env, provider, res.message);
      const alt = otherProvider(env, tried);
      if (alt) {
        await switchProvider(env, alt, "primary_quota");
        continue;
      }
      return { ok: false, defer: "llm_quota" };
    }
    if (res.kind === "rate_limited") return { ok: false, rateLimited: true };
    if (res.kind === "not_configured") return { ok: false, defer: "provider_not_configured" };
    if (res.kind === "invalid_json" || res.kind === "schema")
      return { ok: false, invalid: res.message };
    throw new Error(`llm ${res.kind}: ${res.message}`);
  }
}

/**
 * The 429 retries are spent: hand the step to the backup (immediately, with its own retries) when the primary is the one
 * that kept answering 429; otherwise the report waits for the next scan day as before.
 */
async function afterRateLimit(env: Env, step: string): Promise<StepOutcome> {
  const retry = await rateLimitRetry(env, step);
  if (retry) return retry;
  await exhaustedSet(env);
  if (env.provider)
    env.report.usage.rate_limited_models = [
      ...new Set([...(env.report.usage.rate_limited_models ?? []), env.provider.name]),
    ];
  const alt = otherProvider(env, new Set());
  if (alt) {
    await switchProvider(env, alt, "primary_rate_limited");
    env.report.usage.rate_limit_retries = 0;
    await save(env, { step, ...waitPatch(env, null, "") });
    return { kind: "again", reportId: env.report.id };
  }
  return await defer(env, "llm_quota", step);
}

/**
 * Weekend and 72-hour gate (see core/cadence.ts). Returns the `late` outcome after parking the report as `queued` with its wait
 * fields, or null when the work may run now. `research_now` (manual) and `force` are exempt.
 */
async function waitForWindow(
  env: Env,
  step: string,
  applyCadence: boolean,
): Promise<StepOutcome | null> {
  const { deps, settings, p } = env;
  if (p.trigger === "manual" || p.trigger === "visitor" || p.force) return null;
  const last = applyCadence
    ? await deps.store.lastReportCompletedAt(env.security.securityId)
    : null;
  const gate = aiGate({
    nowMs: deps.now().getTime(),
    weekdaysOnly: settings.ai_weekdays_only,
    minRecheckHours: settings.min_recheck_hours,
    lastActivityMs: last === null ? null : Date.parse(last),
    applyCadence,
  });
  if (gate.allowed) return null;
  const notBefore = new Date(gate.notBeforeMs).toISOString();
  await save(env, {
    status: "queued",
    step,
    notBefore,
    waitReason: gate.reason,
    lastAttemptAt:
      gate.lastActivityMs === null ? null : new Date(gate.lastActivityMs).toISOString(),
    nextAttemptAt: notBefore,
    nextProvider: nextModel(env),
  });
  await applyCards(env);
  await deps.log(
    "research_waiting",
    { report_id: env.report.id, step, reason: gate.reason, not_before: notBefore },
    scope(env),
  );
  return { kind: "late", reportId: env.report.id, step, notBefore };
}

/** Primary filings and company pages go through Jina Reader; the rest is fetched directly (spec 9.4). */
async function fetchSource(
  env: Env,
  src: SourceRow,
): Promise<
  { text: string; status: number; contentType: string } | { error: string; status: number | null }
> {
  const { deps, ctx } = env;
  let jinaTried = false;
  const viaJina = async (): Promise<
    { text: string; status: number; contentType: string } | { error: string; status: number | null }
  > => {
    jinaTried = true;
    if (!(await deps.store.consumeQuota("jina", "requests", 1, "day", AUX_CAPS.jina)))
      return { error: "jina_quota", status: null };
    const r = await deps.fetch.jina(src.url, { apiKey: deps.jinaApiKey, signal: ctx.signal });
    if (!r.ok) return { error: `jina_${r.kind}`, status: r.status ?? null };
    return { text: r.text, status: r.status, contentType: "text/markdown" };
  };
  if (src.kind === "edgar_filing") {
    const r = await viaJina();
    if ("text" in r && r.text.trim().length >= MIN_DOC_CHARS) return r;
  }
  if (src.url.includes("sec.gov"))
    await deps.store.consumeQuota("sec", "requests", 1, "day", AUX_CAPS.sec);
  const d = await deps.fetch.direct(src.url, {
    signal: ctx.signal,
    secUserAgent: deps.secUserAgent,
  });
  if (d.ok && d.text !== null && d.text.length >= MIN_DOC_CHARS) {
    return { text: d.text, status: d.status, contentType: d.contentType };
  }
  const retryable =
    d.ok ||
    d.kind === "content_type" ||
    d.kind === "timeout" ||
    d.status === 401 ||
    d.status === 403 ||
    d.status === 429;
  if (!jinaTried && retryable) {
    const r = await viaJina();
    if ("text" in r && r.text.trim().length >= MIN_DOC_CHARS) return r;
    if ("error" in r) return r;
  }
  if (d.ok)
    return { error: d.text === null ? "pdf_unreadable" : "empty_document", status: d.status };
  return { error: `direct_${d.kind}`, status: d.status ?? null };
}

// ---------------------------------------------------------------- steps

export async function runResearchStep(
  deps: ResearchDeps,
  job: Job,
  ctx: HandlerCtx,
  p: ChainPayload,
): Promise<StepOutcome> {
  const settings = await deps.settings();
  const security = await deps.store.loadSecurity(p.security_id);
  if (!security) throw new Error(`security ${p.security_id} not found`);
  if (p.step === "plan") return await planStep({ deps, job, ctx, p, settings, security });
  if (!p.report_id) throw new Error(`step ${p.step} without report_id`);
  const report = await deps.store.getReport(p.report_id);
  if (!report) throw new Error(`report ${p.report_id} not found`);
  if (report.status === "complete" || report.status === "failed") {
    return {
      kind: "done",
      status: report.status === "complete" ? "complete" : "failed",
      reportId: report.id,
    };
  }
  const provider = report.provider ? (deps.llm[report.provider] ?? null) : null;
  const env: Env = { deps, job, ctx, p, settings, security, report, provider };
  if (report.status === "quota_deferred" || report.status === "queued") {
    await save(env, { status: "running", error: null, notBefore: null });
    await applyCards(env);
  }
  const [name, n] = p.step.split(":");
  const index = Number(n ?? 0);
  if (name === "extract" || name === "synthesize") {
    const waiting = await waitForWindow(env, p.step, false); // a chain that crosses into the weekend pauses here
    if (waiting) return waiting;
  }
  if (env.report.waitReason !== null) await save(env, waitPatch(env, null, ""));
  switch (name) {
    case "prefetch":
      return await prefetchStep(env);
    case "search":
      return await searchStep(env, index);
    case "fetch":
      return await fetchStep(env, index);
    case "extract":
      return await extractStep(env, index);
    case "synthesize":
      return await synthesizeStep(env);
    case "validate":
      return await validateStep(env);
    default:
      throw new Error(`unknown research step ${p.step}`);
  }
}

/** Idempotency key of the report a plan job creates: per Sofia day, or per accepted minute for a visitor request. */
function reportKey(p: ChainPayload, securityId: string): string {
  return p.trigger === "visitor" && p.accepted_at
    ? `${securityId}:visitor:${p.accepted_at}`
    : `${securityId}:${p.trigger}:${p.scan_date_local}`;
}

async function planStep(base: Omit<Env, "report" | "provider">): Promise<StepOutcome> {
  const { deps, job, p, settings, security } = base;
  const { store } = deps;
  const now = deps.now();
  base.exhausted = new Set(await store.exhaustedModels(now.toISOString()));
  const key = reportKey(p, security.securityId);
  const existing = p.report_id
    ? await store.getReport(p.report_id)
    : await store.findReportByKey(key);
  const withReport = (report: ReportRow, provider: LlmProvider | null): Env => ({
    ...base,
    report,
    provider,
  });

  // An existing finished report for this key is final: re-delivery is a no-op (idempotency).
  if (existing && (existing.status === "complete" || (existing.status === "failed" && !p.force))) {
    await applyCards(withReport(existing, null), existing);
    return {
      kind: "done",
      status: existing.status === "complete" ? "reused" : "failed",
      reportId: existing.id,
    };
  }

  const started =
    existing !== null && (existing.status === "running" || existing.status === "quota_deferred");
  const current = await store.currentReport(security.securityId);
  const finding = current?.completedAt
    ? await store.hasOpenFindingSince(security.securityId, current.completedAt)
    : false;
  if (
    !started &&
    REUSE_TRIGGERS.has(p.trigger) &&
    !p.force &&
    current &&
    isReusable(current, p.trigger, settings, now) &&
    !finding
  ) {
    if (existing && existing.status === "queued") await store.deleteReport(existing.id);
    await applyCards(withReport(current, null), current);
    await deps.log(
      "research_reused",
      { report_id: current.id, trigger: p.trigger },
      { scanRunId: job.scan_run_id, securityId: security.securityId },
    );
    return { kind: "done", status: "reused", reportId: current.id };
  }
  const preserve =
    PRESERVE_TRIGGERS.has(p.trigger) ||
    (p.trigger === "new_discount" &&
      current !== null &&
      current.status === "complete" &&
      current.visibility === "public" &&
      !finding);

  const stored = existing?.provider ? deps.llm[existing.provider] : undefined;
  const chosen =
    stored?.configured && !base.exhausted.has(stored.name)
      ? { provider: stored, reason: existing?.fallbackReason ?? null }
      : await chooseProviderWithReason(deps, settings, base.exhausted);
  const provider = chosen.provider;
  const visibility: Visibility =
    p.trigger === "new_discount" || (await store.hasDiscountCard(security.securityId))
      ? "public"
      : "holders";
  let report = existing;
  if (!report) {
    report = await store.createReport({
      idempotencyKey: key,
      securityId: security.securityId,
      companyId: security.companyId,
      scanRunId: job.scan_run_id,
      trigger: p.trigger,
      visibility,
    });
  } else if (report.status === "failed") {
    await store.clearSources(report.id);
    await store.deleteWorkTexts(report.id);
    await store.patchReport(report.id, {
      status: "queued",
      step: null,
      error: null,
      usage: {},
      queriesUsed: 0,
      docsFetched: 0,
      limitations: [],
      missingDocuments: [],
    });
    report = (await store.getReport(report.id)) ?? report;
  }
  const env = withReport(report, provider);
  env.report.usage.preserve_cards = preserve;
  if (p.source) env.report.usage.source = p.source;

  // Cadence: no AI work on a weekend (Sofia) and none within min_recheck_hours of the security's last report. A report that
  // waits keeps its card pending and runs from a side-channel job at the allowed time (manual research_now is exempt).
  const publicCurrent = current !== null && current.visibility === "public";
  const cadenceApplies =
    p.trigger !== "monitor_first" &&
    p.trigger !== "monitor_change" &&
    !finding &&
    (p.trigger !== "new_discount" || publicCurrent);
  const waiting = await waitForWindow(env, "plan", cadenceApplies);
  if (waiting) return waiting;

  if (!provider) {
    const anyConfigured = deps.llmOrder.some((name) => deps.llm[name]?.configured === true);
    return await defer(env, anyConfigured ? "llm_quota" : "provider_not_configured", "plan");
  }

  // null/absent = no cap (R6): nothing to reserve against, the free-quota guards below still apply
  const reportCap = settings.max_full_reports_per_day;
  const reserved = await reserveOnce(
    env,
    "plan",
    reportCap == null
      ? []
      : [
          {
            provider: "research",
            resource: `full_reports:${REPORT_CLASS[p.trigger]}`,
            period: "day",
            limit: reportCap,
          },
        ],
  );
  if (!reserved) return await defer(env, "daily_cap", "plan");

  let cik = security.secCik;
  if (!cik) {
    const ticker = secTicker(security);
    if (ticker) {
      const res = await deps.edgar.resolveCik(ticker);
      if (res.ok && res.value) {
        cik = res.value;
        security.secCik = cik;
        await store.saveSecCik(security.companyId, cik);
      } else if (!res.ok) {
        addLimitation(env, "edgar_unavailable");
      }
    }
  }
  const kind = industryKind(security.sector, security.industry);
  env.report.usage.queries = queryTemplates({
    company: security.companyName,
    ticker: security.ticker,
    researchDate: p.scan_date_local,
    industry: kind,
  });
  env.report.usage.industry_note = industryNote(kind);
  await save(env, {
    status: "running",
    provider: provider.name,
    model: provider.model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    scanRunId: job.scan_run_id,
    startedAt: report.startedAt ?? now.toISOString(),
    step: "plan",
    error: null,
    notBefore: null,
    limitations: env.report.limitations,
    fallbackReason: chosen.reason,
    ...waitPatch(env, null, ""),
  });
  await applyCards(env);
  return next(env, "plan");
}

async function prefetchStep(env: Env): Promise<StepOutcome> {
  const { deps, report, security } = env;
  const cik = security.secCik;
  let filings: Filing[] = [];
  if (cik) {
    const res = await deps.edgar.submissions(cik);
    if (res.ok) filings = res.value;
    else addLimitation(env, "edgar_unavailable");
  }
  const picked = pickFilings(filings);
  const chosen = [picked.annual, picked.interim, ...picked.current].filter(
    (f): f is Filing => f !== null,
  );
  if (cik && chosen.length > 0) {
    const rows: NewSource[] = chosen.map((f) => {
      const url = deps.edgar.filingUrl(cik, f.accession, f.primaryDocument);
      return {
        url,
        canonicalUrl: canonicalUrl(url),
        title: `${f.form} filed ${f.filingDate}`,
        publisher: "SEC EDGAR",
        kind: "edgar_filing",
        publishedAt: null,
        filingDate: f.filingDate,
        excerpt: null,
        meta: { form: f.form, accession: f.accession },
      };
    });
    await deps.store.addSources(report.id, rows);
  }
  report.usage.deterministic = renderFilingList(chosen);
  await save(env, { step: "prefetch", limitations: report.limitations });
  return next(env, "prefetch");
}

async function tavilyExhausted(env: Env, step: string, why: string): Promise<StepOutcome> {
  const sources = await env.deps.store.listSources(env.report.id);
  const primary = sources.filter((s) => s.kind === "edgar_filing").length;
  await env.deps.log(
    "search_quota_low",
    { step, why, primary_documents: primary },
    scope(env, "warn"),
  );
  if (primary >= 2) {
    env.report.usage.limited_sources = true;
    addLimitation(env, "limited_sources");
    await save(env, { limitations: env.report.limitations });
    return next(env, step);
  }
  return await defer(env, "tavily_quota", step);
}

async function searchStep(env: Env, n: number): Promise<StepOutcome> {
  const { deps, report, settings } = env;
  const usage = report.usage;
  if (usage.limited_sources) return next(env, `search:${n}`);
  // no key: nothing to reserve, the report waits as provider_not_configured instead of burning quota
  if (deps.tavily.configured === false)
    return await defer(env, "provider_not_configured", `search:${n}`);
  const queries = usage.queries ?? [];
  const indexes = n === 1 ? [0, 1, 2] : [3, 4, 5];
  const done = new Set(usage.queries_done ?? []);
  if (n === 1 && !usage.low_quota_logged) {
    const monthly = await deps.store.quotaUsed("tavily", "credits", "month");
    if (monthly >= 0.9 * settings.tavily_monthly_budget) {
      usage.low_quota_logged = true;
      await deps.log(
        "search_quota_low",
        { monthly, budget: settings.tavily_monthly_budget },
        scope(env, "warn"),
      );
    }
  }
  for (const i of indexes) {
    const query = queries[i];
    if (query === undefined || done.has(i)) continue;
    if (!(await consumeAll(env, tavilySpecs(settings, true))))
      return await tavilyExhausted(env, `search:${n}`, "cap");
    const res = await deps.tavily.search(query, env.ctx.signal);
    if (!res.ok && res.kind === "rate_limited") {
      const retry = await rateLimitRetry(env, `search:${n}`, null);
      if (retry) return retry;
    }
    if (
      !res.ok &&
      (res.kind === "quota" || res.kind === "rate_limited" || res.kind === "not_configured")
    ) {
      return await tavilyExhausted(env, `search:${n}`, res.kind);
    }
    if (res.ok) {
      const rows: NewSource[] = res.results.map((h) => ({
        url: h.url,
        canonicalUrl: canonicalUrl(h.url),
        title: h.title,
        publisher: hostOf(h.url),
        kind: isIrUrl(h.url) ? "ir_page" : "search_result",
        publishedAt: toIso(h.publishedDate),
        filingDate: null,
        excerpt: h.snippet === "" ? null : h.snippet.slice(0, 2000),
        meta: { query, dateSource: "search" },
      }));
      await deps.store.addSources(report.id, rows);
    } else {
      await deps.log(
        "search_quota_low",
        { kind: res.kind, status: res.status ?? null },
        scope(env, "warn"),
      );
    }
    done.add(i);
    usage.queries_done = [...done];
    await save(env, { queriesUsed: done.size });
  }
  await save(env, { step: `search:${n}` });
  return next(env, `search:${n}`);
}

const candidateOf = (s: SourceRow): RankCandidate => ({
  evidenceId: s.evidenceId,
  url: s.canonicalUrl,
  kind: s.kind,
  form: s.meta.form ?? null,
  publishedAt: s.publishedAt,
  filingDate: s.filingDate,
});

async function fetchStep(env: Env, n: number): Promise<StepOutcome> {
  const { deps, report } = env;
  const sources = await deps.store.listSources(report.id);
  if (!report.usage.selected) {
    report.usage.selected = selectDocuments(
      rankDocuments(sources.filter((s) => s.verification === "pending").map(candidateOf)),
    ).map((c) => c.evidenceId);
    await save(env);
  }
  const slice = report.usage.selected.slice((n - 1) * 3, n * 3);
  for (const id of slice) {
    const src = sources.find((s) => s.evidenceId === id);
    if (src?.verification !== "pending") continue;
    if (env.ctx.deadline - performance.now() < STEP_MIN_MS)
      return { kind: "again", reportId: report.id };
    const res = await fetchSource(env, src);
    const now = deps.now().toISOString();
    if ("text" in res) {
      const text = capText(res.text, MAX_DOC_CHARS);
      await deps.store.putWorkText(report.id, src.evidenceId, text);
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "ok",
        httpStatus: res.status,
        contentType: res.contentType,
        contentHash: await deps.sha256(text),
        excerpt: text.slice(0, 2000),
        retrievedAt: now,
        livenessVerifiedAt: now,
      });
      report.docsFetched += 1;
    } else {
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "failed",
        httpStatus: res.status,
        meta: { ...src.meta, fetch_error: res.error },
      });
      report.usage.missing = dedupe([
        ...(report.usage.missing ?? []),
        `${src.title ?? src.url}: not retrieved (${res.error})`,
      ]);
    }
    await save(env, { docsFetched: report.docsFetched });
  }
  await save(env, { step: `fetch:${n}` });
  return next(env, `fetch:${n}`);
}

async function extractStep(env: Env, n: number): Promise<StepOutcome> {
  const { deps, report } = env;
  const sources = (await deps.store.listSources(report.id))
    .filter((s) => s.verification === "ok")
    .sort((a, b) => a.evidenceId - b.evidenceId);
  for (const src of sources.slice((n - 1) * 2, n * 2)) {
    if (src.meta.extracted) continue;
    if (env.ctx.deadline - performance.now() < STEP_MIN_MS)
      return { kind: "again", reportId: report.id };
    const text = await deps.store.getWorkText(report.id, src.evidenceId);
    if (text === null) {
      await deps.store.patchSource(report.id, src.evidenceId, {
        meta: { ...src.meta, extracted: true },
      });
      continue;
    }
    const stage1User = (docText: string) =>
      buildStage1User({
        evidenceId: src.evidenceId,
        title: src.title,
        kind: src.kind,
        dateLabel: dateLabel(src),
        url: src.canonicalUrl,
        text: docText,
      });
    // the text the model actually saw (a budgeted provider reads only the start of a long document): quotes are checked against it
    let sentText = text;
    const res = await callLlm(env, `extract:${n}`, 4096, (budget) => {
      const room = charsLeft(
        budget.inputChars,
        STAGE1_SYSTEM.length + STAGE1_SCHEMA_CHARS + stage1User("").length,
      );
      sentText = room === null || text.length <= room ? text : text.slice(0, room);
      return {
        req: {
          system: STAGE1_SYSTEM,
          user: stage1User(sentText),
          schema: STAGE1_OUTPUT_SCHEMA,
          schemaName: "stage1_facts",
          temperature: 0.1,
        },
        trimmed: sentText.length < text.length,
      };
    });
    if (!res.ok && "rateLimited" in res) {
      await save(env);
      return await afterRateLimit(env, `extract:${n}`);
    }
    if (!res.ok && "unavailable" in res) {
      await save(env);
      return await unavailableBackoff(env, `extract:${n}`);
    }
    if (!res.ok && "defer" in res) {
      await save(env);
      return await defer(env, res.defer, `extract:${n}`);
    }
    if (res.ok && res.trimmed) {
      report.usage.missing = dedupe([
        ...(report.usage.missing ?? []),
        `${(src.title ?? src.url).slice(0, 70)}: read only in part (backup model size limit)`,
      ]);
      await markTrimmed(env);
    }
    const validated = res.ok
      ? validateStage1Facts(res.json, sentText)
      : { valid: false, kept: [], dropped: 0 };
    if (!validated.valid) addLimitation(env, `extraction_failed:E${src.evidenceId}`);
    report.usage.dropped_facts = (report.usage.dropped_facts ?? 0) + validated.dropped;
    await deps.store.patchSource(report.id, src.evidenceId, {
      extracted: validated.kept,
      meta: { ...src.meta, extracted: true },
    });
    await save(env, { limitations: report.limitations });
  }
  await save(env, { step: `extract:${n}` });
  return next(env, `extract:${n}`);
}

const STAGE1_SCHEMA_CHARS = JSON.stringify(STAGE1_OUTPUT_SCHEMA).length;
const STAGE2_SCHEMA_CHARS = JSON.stringify(RESEARCH_OUTPUT_SCHEMA).length;
/** Room kept in the Stage 2 request for the "evidence left out" line added to the missing list. */
const OMITTED_NOTE_RESERVE_CHARS = 260;

/** The backup model worked from a trimmed evidence set: the card says so (research_reports.evidence_trimmed). */
async function markTrimmed(env: Env): Promise<void> {
  if (env.report.evidenceTrimmed !== true) await save(env, { evidenceTrimmed: true });
}

const ledgerOf = (s: SourceRow): LedgerEntry => ({
  evidenceId: s.evidenceId,
  url: s.canonicalUrl,
  title: s.title,
  publisher: s.publisher,
  kind: s.kind,
  publishedAt: s.publishedAt,
  filingDate: s.filingDate,
  retrievedAt: s.retrievedAt,
  verification: s.verification,
  facts: s.extracted,
});

function derivedMissing(env: Env, sources: SourceRow[]): string[] {
  const hasOk = (forms: readonly string[]) =>
    sources.some(
      (s) =>
        s.kind === "edgar_filing" && s.verification === "ok" && forms.includes(s.meta.form ?? ""),
    );
  const out = [...(env.report.usage.missing ?? [])];
  if (!hasOk(ANNUAL_FORMS)) out.push("Latest annual report (10-K, 20-F or 40-F): not obtained");
  if (!hasOk(INTERIM_FORMS)) out.push("Latest quarterly or interim report: not obtained");
  if (env.report.usage.limited_sources)
    out.push("Web search was unavailable (quota exhausted): evidence may be incomplete");
  return dedupe(out);
}

function promptVars(env: Env): PromptVars {
  return {
    companyName: env.security.companyName,
    ticker: env.security.ticker,
    primaryExchange: env.security.primaryExchange,
    reportingCurrency: env.security.reportingCurrency,
    researchDate: env.p.scan_date_local,
  };
}

async function synthesizeStep(env: Env): Promise<StepOutcome> {
  const { deps, report } = env;
  const attempt = report.usage.synth_attempt ?? 1;
  const sources = await deps.store.listSources(report.id);
  const byId = new Map(sources.map((s) => [s.evidenceId, s]));
  const withFacts = rankDocuments(
    sources.filter((s) => s.verification === "ok" && s.extracted.length > 0).map(candidateOf),
  );
  const headlines = rankDocuments(
    sources
      .filter((s) => s.verification === "pending" && s.kind !== "edgar_filing")
      .map(candidateOf),
  ).slice(0, 6);
  const ordered = [...withFacts, ...headlines].flatMap((c) => {
    const s = byId.get(c.evidenceId);
    return s ? [ledgerOf(s)] : [];
  });
  const fullFit = fitEvidence(ordered);
  const factCount = (entries: readonly LedgerEntry[]) =>
    entries.reduce((n, e) => n + e.facts.length, 0);
  const stage2User = (shown: readonly LedgerEntry[], missing: readonly string[]) =>
    buildStage2User({
      vars: promptVars(env),
      industryNote: report.usage.industry_note ?? "",
      deterministicData: report.usage.deterministic ?? "",
      shown,
      missing,
      feedback: report.usage.retry_feedback ?? undefined,
    });
  // what the model was actually shown (a budgeted provider gets less than the full set); shown_ids must match it
  let shown: LedgerEntry[] = fullFit.shown;
  const res = await callLlm(env, "synthesize", 6144, (budget) => {
    const missing = derivedMissing(env, sources);
    const room = charsLeft(
      budget.inputChars,
      EVIDENCE_PREAMBLE.length +
        STAGE2_SCHEMA_CHARS +
        stage2User([], missing).length +
        OMITTED_NOTE_RESERVE_CHARS,
      1000,
    );
    const fit =
      room === null ? fullFit : fitEvidence(ordered, Math.min(room, STAGE2_EVIDENCE_MAX_CHARS));
    const trimmed =
      fit.shown.length < fullFit.shown.length || factCount(fit.shown) < factCount(fullFit.shown);
    // evidence cut only by this provider's budget is reported to the model (and so to the report) as left out
    const cutIds = fit.omitted.filter((id) => !fullFit.omitted.includes(id));
    const note =
      cutIds.length === 0
        ? []
        : [
            `Evidence items left out to fit the backup model's size limit: ${cutIds
              .slice(0, 12)
              .map((id) => `E${id}`)
              .join(", ")}${cutIds.length > 12 ? ` and ${cutIds.length - 12} more` : ""}`,
          ];
    shown = [...fit.shown].sort((a, b) => a.evidenceId - b.evidenceId);
    return {
      req: {
        system: EVIDENCE_PREAMBLE,
        user: stage2User(shown, [...missing, ...note]),
        schema: RESEARCH_OUTPUT_SCHEMA,
        schemaName: "research_output",
        temperature: 0.2,
      },
      trimmed,
    };
  });
  if (!res.ok && "rateLimited" in res) {
    await save(env);
    return await afterRateLimit(env, "synthesize");
  }
  if (!res.ok && "unavailable" in res) {
    await save(env);
    return await unavailableBackoff(env, "synthesize");
  }
  if (!res.ok && "defer" in res) {
    await save(env);
    return await defer(env, res.defer, "synthesize");
  }
  if (!res.ok && "tooLarge" in res) {
    // the request itself was too big even after one retry with half the input: a repeat would only be as large
    return await failReport(env, "invalid_json");
  }
  if (!res.ok) {
    if (attempt === 1) {
      report.usage.synth_attempt = 2;
      report.usage.retry_feedback =
        "Your previous reply was not valid JSON matching the schema. Return only JSON that matches the schema.";
      await save(env, { step: "synthesize" });
      return { kind: "retry_synthesize", reportId: report.id };
    }
    return await failReport(env, "invalid_json");
  }
  report.usage.stage2 = { attempt, json: res.json };
  report.usage.shown_ids = shown.map((e) => e.evidenceId);
  if (res.trimmed) await markTrimmed(env);
  await save(env, { step: "synthesize" });
  return next(env, "synthesize", attempt === 2 ? "r2" : undefined);
}

async function validateStep(env: Env): Promise<StepOutcome> {
  const { deps, report, p } = env;
  const stage2 = report.usage.stage2;
  if (!stage2) throw new Error("validate step without a Stage 2 output");
  const attempt = stage2.attempt;
  const verdict = validateResearchOutput(stage2.json, report.usage.shown_ids ?? [], attempt);
  const retry = async (feedback: string): Promise<StepOutcome> => {
    report.usage.synth_attempt = 2;
    report.usage.retry_feedback = feedback;
    report.usage.stage2 = null;
    await save(env, { step: "validate" });
    return { kind: "retry_synthesize", reportId: report.id };
  };
  if (!verdict.ok || !verdict.output) {
    if (verdict.retryWith && attempt === 1) return await retry(verdict.retryWith);
    return await failReport(env, verdict.failure ?? "invalid_json");
  }
  const output: ResearchOutput = verdict.output;

  // Citation liveness: a cited source must have been fetched this run, or pass a GET now (<= 4 per attempt).
  const sources = await deps.store.listSources(report.id);
  const cited = sources.filter((s) => output.cited_evidence_ids.includes(s.evidenceId));
  const unverified = cited
    .filter((s) => s.verification !== "ok")
    .sort((a, b) => a.evidenceId - b.evidenceId);
  // the budget of 4 GETs is cumulative per report: the Stage-2 retry does not get a fresh one
  const budget = Math.max(0, 4 - (report.usage.liveness_checks ?? 0));
  let checks = 0;
  const bad: SourceRow[] = [];
  for (const src of unverified) {
    if (checks >= budget) {
      bad.push(src);
      continue;
    }
    checks++;
    const res = await deps.fetch.direct(src.url, {
      timeoutMs: 8000,
      signal: env.ctx.signal,
      secUserAgent: deps.secUserAgent,
    });
    const now = deps.now().toISOString();
    if (res.ok) {
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "ok",
        httpStatus: res.status,
        contentType: res.contentType,
        retrievedAt: now,
        livenessVerifiedAt: now,
      });
      src.verification = "ok";
    } else {
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "failed",
        httpStatus: res.status ?? null,
      });
      bad.push(src);
    }
  }
  report.usage.liveness_checks = (report.usage.liveness_checks ?? 0) + checks;
  if (bad.length > 0) {
    const ids = bad.map((s) => `E${s.evidenceId}`).join(", ");
    if (attempt === 1)
      return await retry(
        `These sources could not be verified and must not be cited: ${ids}. Cite only verified evidence.`,
      );
    return await failReport(env, "citation_verification_failed");
  }

  const now = deps.now().toISOString();
  const limitations = dedupe([
    ...report.limitations,
    ...output.limitations,
    ...verdict.limitations,
  ]);
  if (output.research_cutoff_date !== p.scan_date_local) limitations.push("cutoff_date_mismatch");
  const missing = dedupe([...derivedMissing(env, sources), ...output.missing_documents]);
  const reportMd = `${output.report_md.trim()}\n\n${renderSources(cited.map(ledgerOf))}\n`;
  await save(env, {
    status: "complete",
    step: "validate",
    reportMd,
    summary: output.summary,
    newsSummary: output.news_reason,
    conclusion: output.conclusion,
    bankruptcyRisk: output.bankruptcy_risk,
    materialDamageEstablished: output.material_damage_established,
    sufficientEvidence: output.sufficient_evidence,
    citedEvidenceIds: output.cited_evidence_ids,
    claims: output.facts_vs_claims,
    missingDocuments: missing,
    limitations,
    researchCutoffDate: p.scan_date_local,
    completedAt: now,
    error: null,
    notBefore: null,
    // the writer of the report text: the provider that ran the synthesis (report.provider follows every hand-over)
    provider: env.provider?.name ?? report.provider,
    model: env.provider?.model ?? report.model,
    ...waitPatch(env, null, ""),
  });
  for (const src of cited)
    await deps.store.patchSource(report.id, src.evidenceId, { usedInReport: true });
  await deps.store.deleteWorkTexts(report.id);
  const superseded = await deps.store.promoteReport(report.id);
  // work of the same security that is still queued, running or parked is now redundant: the finished report answers it
  await deps.store.supersedeInflightReports(env.security.securityId, report.id);
  env.report.isCurrent = true;
  env.report.supersedesId = superseded;
  await applyCards(env);
  const { category } = classifyOperational(toFacts(env.report));
  await deps.store.updateMonitorReport(env.security.securityId, report.id, category);
  await deps.log(
    "research_complete",
    { report_id: report.id, category, superseded, tokens: report.usage.tokens ?? null },
    scope(env),
  );
  return { kind: "done", status: "complete", reportId: report.id };
}

/**
 * Last-attempt safety net of the research handler: a job that exhausted its retries must not leave its report `running` forever.
 * Returns the failed outcome, or null when there is no unfinished report to fail.
 */
export async function failReportAfterDeadJob(
  deps: ResearchDeps,
  job: Job,
  ctx: HandlerCtx,
  p: ChainPayload,
  code: string,
): Promise<StepOutcome | null> {
  const security = await deps.store.loadSecurity(p.security_id);
  if (!security) return null;
  const report = p.report_id
    ? await deps.store.getReport(p.report_id)
    : await deps.store.findReportByKey(reportKey(p, p.security_id));
  if (!report || report.status === "complete" || report.status === "failed") return null;
  const settings = await deps.settings();
  const provider = report.provider ? (deps.llm[report.provider] ?? null) : null;
  return await failReport({ deps, job, ctx, p, settings, security, report, provider }, code);
}
