import { canonicalUrl } from "../../_shared/adapters/fetchers/extract.ts";
import type { MonitorStore } from "../../_shared/adapters/monitor_store.ts";
import type {
  HandlerCtx,
  Job,
  NewJob,
  ResearchDeps,
} from "../../_shared/adapters/research_types.ts";
import { aiGate, nextAiWindowStart, scheduleHorizon } from "../../_shared/core/cadence.ts";
import { type StepBudget, stepBudget } from "../../_shared/core/llm-budget.ts";
import { WATCH_FORMS } from "../../_shared/core/research.ts";
import {
  buildChangeUser,
  CHANGE_CLASSIFICATION_SCHEMA,
  CHANGE_SYSTEM,
  type ChangeItem,
  type ChangeOutput,
  computeDelta,
  findingAction,
  fingerprintInput,
  type ItemLike,
  isEmptyDelta,
  type LatestLike,
  mergeSeen,
  type SeenItems,
  strongestKeyword,
  validateChangeOutput,
} from "../../_shared/core/risk.ts";
import { chooseProvider, TRIGGER_PRIORITY, tavilySpecs } from "./research_steps.ts";

const CHECK_PRIORITY = 50;
const CHANGE_SCHEMA_CHARS = JSON.stringify(CHANGE_CLASSIFICATION_SCHEMA).length;

function checkJob(
  scanRunId: string,
  securityId: string,
  scanDateLocal: string,
  notBeforeMs: number | null,
): NewJob {
  const payload = { kind: "change_check", security_id: securityId, scan_date_local: scanDateLocal };
  if (notBeforeMs === null)
    return {
      scanRunId,
      stage: "research",
      key: `research:${securityId}:check`,
      priority: CHECK_PRIORITY,
      payload,
    };
  const at = new Date(notBeforeMs).toISOString();
  // a check that waits past the scan run is a side-channel job: it never keeps the run open (migration 20261015008000)
  return {
    scanRunId,
    stage: "research",
    key: `research:${securityId}:check:late:${at}`,
    priority: CHECK_PRIORITY,
    payload: { ...payload, late: true },
    notBefore: at,
  };
}

/**
 * Stage 10 seeder extra: one change check per security that is due, every `min_recheck_hours` (72) after its last check.
 * Due means a holder's monitor row, or a persisting discount nobody holds (watch state on its current report). Nothing runs on a
 * Saturday or Sunday: a check that is due now on a weekend, or falls due over the weekend (a Friday or Saturday scan looks ahead
 * to Monday 10:00 Sofia, because no scan runs on Sunday and Monday morning), is queued with not_before Monday 10:00.
 */
export function seedChecks(deps: ResearchDeps, monitor: MonitorStore) {
  return async (scanRunId: string, scanDateLocal: string): Promise<number> => {
    const settings = await deps.settings();
    const now = deps.now();
    const nowMs = now.getTime();
    const horizonMs = scheduleHorizon(nowMs, settings.ai_weekdays_only);
    const windowNow = nextAiWindowStart(nowMs, settings.ai_weekdays_only);
    const targets = new Map<string, number>(); // security id -> not_before (epoch ms)
    for (const id of await monitor.listDue(now.toISOString())) targets.set(id, windowNow);
    if (horizonMs > nowMs)
      for (const id of await monitor.listDue(new Date(horizonMs).toISOString()))
        if (!targets.has(id)) targets.set(id, horizonMs);

    for (const [securityId, notBeforeMs] of targets)
      await deps.store.enqueueJob(
        checkJob(scanRunId, securityId, scanDateLocal, notBeforeMs > nowMs ? notBeforeMs : null),
      );
    return targets.size;
  };
}

type Outcome =
  | "skipped"
  | "baseline"
  | "waiting"
  | "no_delta"
  | "sources_unavailable"
  | "deferred_cap"
  | "deferred_llm"
  | "deferred_provider"
  | "llm_invalid"
  | "not_material"
  | "material";

type Channel = "edgar" | "rss" | "yahoo";
const CHANNELS: Channel[] = ["edgar", "rss", "yahoo"];
/** Yahoo news is only queried for US-style symbols (no exchange suffix). */
const US_SYMBOL = /^[A-Z][A-Z0-9-]{0,5}$/;

/**
 * Gathers the current item ids of every source of one security. A channel that cannot be read stays `undefined` and is
 * listed in `unavailable`: it is never mistaken for "no change" and never blocks the other channels.
 */
async function gatherLatest(
  deps: ResearchDeps,
  security: NonNullable<Awaited<ReturnType<ResearchDeps["store"]["loadSecurity"]>>>,
  ctx: HandlerCtx,
): Promise<{ latest: LatestLike; unavailable: Channel[] }> {
  const latest: LatestLike = {};
  const unavailable: Channel[] = [];

  try {
    let cik = security.secCik;
    if (!cik && security.ticker) {
      const res = await deps.edgar.resolveCik(security.ticker);
      if (!res.ok) throw new Error(res.message);
      if (res.value) {
        cik = res.value;
        await deps.store.saveSecCik(security.companyId, cik);
      }
    }
    if (cik) {
      const res = await deps.edgar.submissions(cik);
      if (!res.ok) throw new Error(res.message);
      latest.edgar = res.value
        .filter((f) => WATCH_FORMS.includes(f.form))
        .map((f) => ({
          id: f.accession,
          title: `${f.form} filed ${f.filingDate}`,
          link: deps.edgar.filingUrl(cik as string, f.accession, f.primaryDocument),
          publishedAt: f.filingDate,
          form: f.form,
        }));
    }
  } catch {
    unavailable.push("edgar");
  }

  if (security.irRssUrls.length > 0) {
    const items: ItemLike[] = [];
    let failed = false;
    for (const url of security.irRssUrls) {
      try {
        const res = await deps.fetch.feed(url, { signal: ctx.signal });
        if (!res.ok) failed = true;
        else
          for (const i of res.items)
            items.push({ id: i.guid, title: i.title, link: i.link, publishedAt: i.published });
      } catch {
        failed = true;
      }
    }
    // A partly readable set of feeds would hide changes of the broken one: the channel is unavailable as a whole.
    if (failed) unavailable.push("rss");
    else latest.rss = items;
  }

  const symbol = security.newsSymbol ?? security.ticker;
  if (symbol && US_SYMBOL.test(symbol)) {
    try {
      latest.yahoo = (await deps.yahooNews(symbol)).map((n) => ({
        id: n.uuid,
        title: n.title,
        link: n.link,
        publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime).toISOString() : null,
      }));
    } catch {
      unavailable.push("yahoo");
    }
  }
  return { latest, unavailable };
}

export function riskCheckHandler(deps: ResearchDeps, monitor: MonitorStore) {
  return async (
    job: Job,
    ctx: HandlerCtx,
  ): Promise<{ outcome: Outcome; detail?: string; unavailable?: Channel[] }> => {
    const state = { unavailable: [] as Channel[] };
    const res = await runCheck(deps, monitor, job, ctx, state);
    return state.unavailable.length > 0 ? { ...res, unavailable: state.unavailable } : res;
  };
}

async function runCheck(
  deps: ResearchDeps,
  monitor: MonitorStore,
  job: Job,
  ctx: HandlerCtx,
  state: { unavailable: Channel[] },
): Promise<{ outcome: Outcome; detail?: string }> {
  const securityId = String(job.payload.security_id ?? "");
  const scanDate = String(job.payload.scan_date_local ?? "");
  const scope = { scanRunId: job.scan_run_id, securityId };
  const now = deps.now();
  const nowIso = now.toISOString();
  const settings = await deps.settings();
  const nextDueAt = new Date(now.getTime() + settings.min_recheck_hours * 3_600_000).toISOString();
  // a check that already runs as a side-channel job queues what it spawns the same way (it must not reopen a finished run)
  const lateExtra = job.payload.late === true ? { late: true } : {};

  const security = await deps.store.loadSecurity(securityId);
  const rows = await monitor.rows(securityId);
  // A persisting discount nobody holds has no monitor row: its state is the watch on its current report, and there is
  // no user to tell, so a material finding goes straight to a fresh report.
  const watch = rows.length === 0 ? await monitor.watch(securityId) : null;
  const head = rows[0] ?? (watch ? { lastReportId: watch.reportId, seen: watch.seen } : undefined);
  if (!security || !head)
    return { outcome: "skipped", detail: security ? "not_monitored" : "unknown_security" };
  const touch = (patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems }) =>
    watch ? monitor.touchWatch(watch.reportId, patch) : monitor.touch(securityId, patch);

  // No AI work on a weekend (Sofia): queue this check for Monday 10:00 instead. The cadence itself is the seeder's job (it
  // only queues checks that are due), so only the weekend counts here.
  const gate = aiGate({
    nowMs: now.getTime(),
    weekdaysOnly: settings.ai_weekdays_only,
    minRecheckHours: settings.min_recheck_hours,
    lastActivityMs: null,
    applyCadence: false,
  });
  if (!gate.allowed) {
    await deps.store.enqueueJob(checkJob(job.scan_run_id, securityId, scanDate, gate.notBeforeMs));
    return { outcome: "waiting", detail: gate.reason };
  }

  // Step 5: no report yet means a full `monitor_first` report regardless of the delta.
  if (!head.lastReportId && !(await deps.store.hasAnyReport(securityId))) {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id,
      stage: "research",
      key: `research:${securityId}:monitor_first:plan`,
      priority: TRIGGER_PRIORITY.monitor_first,
      payload: {
        security_id: securityId,
        trigger: "monitor_first",
        scan_date_local: scanDate,
        ...lateExtra,
      },
    });
  }

  const { latest, unavailable } = await gatherLatest(deps, security, ctx);
  state.unavailable = unavailable;
  if (unavailable.length > 0)
    await deps.log(
      "research_quota_deferred",
      { check: "source_unavailable", unavailable },
      { ...scope, level: "warn" },
    );

  // Per channel: a channel never observed before only records a baseline (the full report covers its history).
  const baseline = CHANNELS.filter((c) => head.seen[c] === undefined && latest[c] !== undefined);
  const seen: SeenItems = { ...head.seen };
  for (const c of baseline) seen[c] = (latest[c] ?? []).map((i) => i.id);
  const observed = CHANNELS.filter((c) => head.seen[c] !== undefined);
  const acknowledged = (): SeenItems => {
    const merged = mergeSeen(seen, latest);
    for (const c of CHANNELS)
      if (seen[c] === undefined && latest[c] === undefined) delete merged[c];
    return merged;
  };
  if (observed.length === 0) {
    if (baseline.length > 0) await touch({ lastCheckAt: nowIso, nextDueAt, seen: acknowledged() });
    else await touch({ lastCheckAt: nowIso, nextDueAt });
    return {
      outcome: unavailable.length > 0 && baseline.length === 0 ? "sources_unavailable" : "baseline",
    };
  }
  const delta = computeDelta(seen, latest);
  // Step 2: nothing new means no search and no model call.
  if (isEmptyDelta(delta)) {
    await touch({
      lastCheckAt: nowIso,
      nextDueAt,
      ...(baseline.length > 0 ? { seen: acknowledged() } : {}),
    });
    return { outcome: unavailable.length > 0 ? "sources_unavailable" : "no_delta" };
  }

  if (
    !(await deps.store.consumeQuota(
      "research",
      "change_checks",
      1,
      "day",
      settings.max_change_checks_per_day,
    ))
  ) {
    await deps.log("research_quota_deferred", { check: "daily_cap" }, { ...scope, level: "warn" });
    return { outcome: "deferred_cap" };
  }
  const provider = await chooseProvider(deps, settings);
  if (!provider) {
    await deps.log("llm_error", { check: "provider_not_configured" }, { ...scope, level: "warn" });
    return { outcome: "deferred_provider" };
  }

  // Numbered evidence: EDGAR filings and company IR items are primary; Yahoo headlines and search hits are not.
  const items: ChangeItem[] = [];
  const add = (kind: ChangeItem["kind"], i: ItemLike, primary: boolean, excerpt = "") =>
    items.push({
      id: items.length + 1,
      kind,
      title: i.title,
      date: i.publishedAt,
      excerpt,
      primary,
      url: i.link,
    });
  for (const i of delta.edgar) add("edgar_filing", i, true);
  for (const i of delta.rss) add("rss", i, true);
  for (const i of delta.yahoo) add("yahoo_news", i, false);

  // At most one Tavily query per check, only when the credits allow it.
  const keyword = strongestKeyword(delta.keywords) ?? "announcement";
  let granted = true;
  for (const spec of tavilySpecs(settings, false)) {
    if (
      !(await deps.store.consumeQuota(spec.provider, spec.resource, 1, spec.period, spec.limit))
    ) {
      granted = false;
      break;
    }
  }
  if (granted) {
    const res = await deps.tavily.search(
      `${security.companyName} ${security.ticker} ${keyword}`,
      ctx.signal,
    );
    if (res.ok) {
      for (const h of res.results.slice(0, 3)) {
        add(
          "search_result",
          { id: h.url, title: h.title, link: h.url, publishedAt: h.publishedDate ?? null },
          false,
          h.snippet,
        );
      }
    }
  }

  const previous = await monitor.previousAssessment(securityId);
  // sized per provider: a provider with a token budget (Groq free tier) gets fewer items than the full 16,000 characters
  const userFor = (budget: StepBudget): string =>
    buildChangeUser({
      company: security.companyName,
      ticker: security.ticker,
      previous,
      items,
      maxChars:
        budget.inputChars === null
          ? undefined
          : Math.max(1500, budget.inputChars - CHANGE_SYSTEM.length - CHANGE_SCHEMA_CHARS),
    });
  const allowed = items.map((i) => i.id);
  let answer: ChangeOutput | null = null;
  let current = provider; // an overloaded provider hands the check to the other configured one, once
  const tried = new Set<string>([provider.name]);
  let halvedOn: string | null = null; // a "request too large" answer gets ONE retry with half the input, then the check ends
  for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
    if (
      !(await deps.store.consumeQuota(
        current.name,
        "llm_requests",
        1,
        "day",
        settings.llm_daily_request_cap,
      ))
    ) {
      await deps.log("research_quota_deferred", { check: "llm_cap" }, { ...scope, level: "warn" });
      return { outcome: "deferred_llm" };
    }
    const budget = stepBudget(current.budget, 1024, halvedOn === current.name ? 1 : 0);
    const res = await current.generateJson<unknown>({
      system: CHANGE_SYSTEM,
      user: userFor(budget),
      schema: CHANGE_CLASSIFICATION_SCHEMA,
      schemaName: "change_check",
      maxOutputTokens: budget.maxOutputTokens,
      temperature: 0.1,
      signal: ctx.signal,
    });
    if (!res.ok) {
      await deps.log(
        "llm_error",
        { kind: res.kind, check: true, ...(res.tooLarge ? { too_large: true } : {}) },
        { ...scope, level: "warn" },
      );
      if (res.tooLarge) {
        if (halvedOn === current.name) break; // still too large after halving: the check ends, retried at the next scan
        halvedOn = current.name;
        attempt--; // the smaller request is not a second try of the answer
        continue;
      }
      if (res.kind === "unavailable") {
        const alt = deps.llmOrder
          .map((name) => deps.llm[name])
          .find((p) => p?.configured && !tried.has(p.name));
        if (!alt) return { outcome: "deferred_provider" }; // left unacknowledged: due again at the next scan
        tried.add(alt.name);
        current = alt;
        attempt--; // the hand-over is not a second try of the answer
        continue;
      }
      if (res.kind === "rate_limited" || res.kind === "quota") return { outcome: "deferred_llm" };
      if (res.kind === "not_configured") return { outcome: "deferred_provider" };
      if (res.kind === "invalid_json" || res.kind === "schema") continue;
      throw new Error(`llm ${res.kind}: ${res.message}`);
    }
    const checked = validateChangeOutput(res.json, allowed);
    if (checked.ok) answer = checked.output;
  }
  if (!answer) return { outcome: "llm_invalid" }; // left unacknowledged: retried at the next scan

  const acknowledge = async () => {
    await touch({
      lastCheckAt: nowIso,
      nextDueAt,
      seen: acknowledged(),
    });
  };
  if (!answer.material) {
    await acknowledge();
    return { outcome: "not_material", detail: answer.category };
  }

  const cited = items.filter((i) => answer.evidence_ids.includes(i.id));
  const evidence = cited.map((i) => ({
    id: i.id,
    url: canonicalUrl(i.url),
    title: i.title,
    primary: i.primary,
  }));
  const primaryUrls = evidence.filter((e) => e.primary).map((e) => e.url);
  const fingerprint = await deps.sha256(
    fingerprintInput(
      answer.category,
      primaryUrls.length > 0 ? primaryUrls : evidence.map((e) => e.url),
    ),
  );
  let inserted = false;
  for (const row of rows) {
    const open = await monitor.openFinding(row.userId, securityId, answer.category);
    if (findingAction(open, primaryUrls) === "update" && open) {
      await monitor.updateFinding(open.id, {
        summary: answer.summary,
        severity: answer.severity,
        evidence,
      });
    } else if (
      await monitor.insertFinding({
        userId: row.userId,
        securityId,
        fingerprint,
        category: answer.category,
        severity: answer.severity,
        summary: answer.summary,
        evidence,
      })
    ) {
      inserted = true;
    }
  }
  // holders: a NEW finding triggers the report; a persisting discount nobody holds has no finding to dedupe on, so a report
  // already in flight is the guard
  const queueReport = watch ? !(await deps.store.hasInflightReport(securityId)) : inserted;
  if (queueReport) {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id,
      stage: "research",
      key: `research:${securityId}:monitor_change:plan`,
      priority: TRIGGER_PRIORITY.monitor_change,
      payload: {
        security_id: securityId,
        trigger: "monitor_change",
        scan_date_local: scanDate,
        ...lateExtra,
      },
    });
  }
  await acknowledge();
  await deps.log(
    "research_complete",
    { check: "material", category: answer.category, new_finding: inserted || queueReport },
    scope,
  );
  return { outcome: "material", detail: answer.category };
}
