import type {
  CardRow,
  HandlerCtx,
  Job,
  ReportRow,
  ResearchDeps,
  ResearchStore,
} from "../../_shared/adapters/research_types.ts";
import { classifyOperational } from "../../_shared/core/classify.ts";
import { ageDays, toFacts } from "./research_steps.ts";

const CATEGORY_RANK: Record<string, number> = { green: 0, amber: 1, red: 2, grey: 3, pending: 4 };

export interface OrderInput {
  id: number;
  mode: string;
  rank: number;
  symbol: string;
  category: string;
}

/** Green, then Amber (cleared cards), then withheld Red, Grey, pending; inside a group rank, then symbol (spec 14.4). */
export function assignDisplayOrder(rows: readonly OrderInput[]): Map<number, number> {
  const byMode = new Map<string, OrderInput[]>();
  for (const row of rows) {
    const list = byMode.get(row.mode) ?? [];
    list.push(row);
    byMode.set(row.mode, list);
  }
  const out = new Map<number, number>();
  for (const list of byMode.values()) {
    list.sort(
      (a, b) =>
        (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9) ||
        a.rank - b.rank ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
    for (const [index, row] of list.entries()) out.set(row.id, index + 1);
  }
  return out;
}

/** Time context of the final classification: the reuse window and the clock. */
export interface ReportScope {
  now: Date;
  reuseDays: number;
}

/** A report that has been `running` without any write for this long lost its worker (dead job, killed invocation). */
export const STALE_RUNNING_MS = 6 * 3_600_000;

async function scopeOf(
  deps: Partial<Pick<ResearchDeps, "now" | "settings">>,
): Promise<ReportScope> {
  return {
    now: deps.now?.() ?? new Date(),
    reuseDays: (await deps.settings?.())?.reuse_days ?? 30,
  };
}

/**
 * The report a card is judged by: its linked report, or (card not yet linked) the security's current PUBLIC report
 * but only inside the reuse window. A stale report never clears a NEW discount card: the card stays pending (A-27, financial
 * safety first). A report stuck in `running` is failed here, so the card ends grey `research_failed` instead of pending forever.
 */
async function reportFor(
  store: ResearchStore,
  card: CardRow,
  scope: ReportScope,
): Promise<ReportRow | null> {
  let r: ReportRow | null;
  if (card.researchReportId) {
    r = await store.getReport(card.researchReportId);
  } else {
    const current = await store.currentReport(card.securityId);
    r =
      current !== null &&
      current.visibility === "public" &&
      current.completedAt !== null &&
      ageDays(current.completedAt, scope.now) <= scope.reuseDays
        ? current
        : null;
  }
  if (
    r !== null &&
    r.status === "running" &&
    r.updatedAt !== null &&
    scope.now.getTime() - Date.parse(r.updatedAt) > STALE_RUNNING_MS
  ) {
    await store.patchReport(r.id, { status: "failed", error: "stale_running" });
    await store.deleteWorkTexts(r.id);
    r = { ...r, status: "failed", error: "stale_running" };
  }
  return r;
}

export interface ResearchCoverage {
  cards: number;
  complete: number;
  pending: number;
  deferred: number;
  /** Spec 7.7 key: deferred + not_configured (overwrites P1's initial 0). */
  quota_deferred: number;
  failed: number;
  not_configured: number;
  reused: number;
}

export async function researchCoverage(
  store: ResearchStore,
  scanRunId: string,
  scope?: ReportScope,
): Promise<ResearchCoverage> {
  const at = scope ?? (await scopeOf({}));
  const c: ResearchCoverage = {
    cards: 0,
    complete: 0,
    pending: 0,
    deferred: 0,
    quota_deferred: 0,
    failed: 0,
    not_configured: 0,
    reused: 0,
  };
  // one card per security: the worldwide ranking counts, the us rows are only a view filter
  const seen = new Set<string>();
  for (const card of await store.listCards(scanRunId)) {
    if (card.mode !== "worldwide" || seen.has(card.securityId)) continue;
    seen.add(card.securityId);
    c.cards++;
    const r = await reportFor(store, card, at);
    // a card nobody asked research for (no report, nothing in flight) is not pending work
    if (!r && !(await store.hasActiveReport(card.securityId))) continue;
    if (!r || r.status === "queued" || r.status === "running" || r.status === "stale") c.pending++;
    else if (r.status === "complete") {
      c.complete++;
      if (r.scanRunId !== scanRunId) c.reused++;
    } else if (r.status === "quota_deferred") {
      if (r.error === "provider_not_configured") c.not_configured++;
      else c.deferred++;
    } else c.failed++;
  }
  c.quota_deferred = c.deferred + c.not_configured;
  return c;
}

/** Stage 11 `classify:final`: recompute every card of the run from its report (spec 7.4, 4.8). Idempotent. */
export function classifyFinalHandler(
  deps: Pick<ResearchDeps, "store" | "log"> & Partial<Pick<ResearchDeps, "now" | "settings">>,
) {
  return async (job: Job): Promise<unknown> => {
    const cards = await deps.store.listCards(job.scan_run_id);
    const scope = await scopeOf(deps);
    const resolved: {
      card: CardRow;
      report: ReportRow | null;
      category: string;
      reasonCode: string;
    }[] = [];
    for (const card of cards) {
      const report = await reportFor(deps.store, card, scope);
      const facts = classifyOperational(toFacts(report));
      const category = facts.category;
      let reasonCode = facts.reasonCode;
      // No report and nothing in flight: nobody has asked for research on this card (it stays pending, spec 5.1).
      if (report === null && !(await deps.store.hasActiveReport(card.securityId)))
        reasonCode = "not_requested";
      resolved.push({ card, report, category, reasonCode });
    }
    const order = assignDisplayOrder(
      resolved.map((r) => ({
        id: r.card.id,
        mode: r.card.mode,
        rank: r.card.rank,
        symbol: r.card.symbol,
        category: r.category,
      })),
    );
    const counts: Record<string, number> = {};
    for (const r of resolved) {
      counts[r.category] = (counts[r.category] ?? 0) + 1;
      await deps.store.updateCard(r.card.id, {
        reportId: r.report?.id ?? null,
        category: r.category,
        reasonCode: r.reasonCode,
        summary: r.report?.summary ?? null,
        conclusion: r.report?.conclusion ?? null,
        bankruptcyRisk: r.report?.bankruptcyRisk ?? null,
        completedAt: r.report?.completedAt ?? null,
        displayOrder: order.get(r.card.id) ?? 0,
      });
    }
    await deps.log(
      "classify_final",
      { cards: cards.length, ...counts },
      { scanRunId: job.scan_run_id },
    );
    return { cards: cards.length, categories: counts };
  };
}

/** Stage 11 `publish:final`: `coverage.research` counts, then let P1 recompute the scan status and publication flags. */
export function publishFinalHandler(
  deps: Pick<ResearchDeps, "store" | "log"> & Partial<Pick<ResearchDeps, "now" | "settings">>,
) {
  return async (job: Job, _ctx?: HandlerCtx): Promise<unknown> => {
    const coverage = await researchCoverage(deps.store, job.scan_run_id, await scopeOf(deps));
    await deps.store.mergeCoverage(job.scan_run_id, { research: coverage });
    await deps.store.refreshScanStatus(job.scan_run_id);
    return coverage;
  };
}
