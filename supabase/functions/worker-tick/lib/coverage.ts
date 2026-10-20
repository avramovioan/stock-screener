/** Coverage object of scan_runs.coverage (spec 7.7), computed from stored facts only. Pure. */

export type ResultStatus =
  | "processed"
  | "skipped"
  | "failed"
  | "insufficient_data"
  | "stale"
  | "unprocessed";

export interface CoverageInput {
  exchangesTotal: number;
  failedExchanges: string[];
  rawRows: number;
  companies: number;
  /** Candidate securities of the scan; each has exactly one entry (status "unprocessed" when no result row exists). */
  candidates: Array<{
    status: ResultStatus;
    /** Carried forward or listed on an exchange whose sweep is dead: counts as unprocessed for the list coverage (7.7), whatever its status. */
    unprocessed?: boolean;
  }>;
  /** Securities that are not candidates today but still owe a result (carried forward, previous members of a dead exchange). */
  extraUnprocessed?: number;
  carriedForward: number;
  /** One entry per candidate; a candidate without a price series is { freshness: "unavailable", suspect: false }. */
  prices: Array<{ freshness: "fresh" | "stale" | "unavailable"; suspect: boolean }>;
  fx: { rateDate: string | null; scanDay: number; rateDay: number | null; missing: string[] };
  /** `required`: research jobs the run actually seeded (resumes + monitored holdings); `cards`: distinct discount-card securities. */
  research: { required: number; cards?: number };
  minListCoverage: number;
}

export interface Coverage {
  universe: {
    exchanges_total: number;
    exchanges_ok: number;
    failed_exchanges: string[];
    raw_rows: number;
    companies: number;
  };
  candidates: {
    total: number;
    processed: number;
    skipped: number;
    failed: number;
    insufficient_data: number;
    stale: number;
    unprocessed: number;
    carried_forward: number;
  };
  prices: { fresh: number; stale: number; unavailable: number; suspect: number };
  fx: { rate_date: string | null; stale: boolean; missing: string[] };
  research: {
    required: number;
    complete: number;
    pending: number;
    cards: number;
    quota_deferred: number;
    failed: number;
  };
  monitoring: { holdings_monitored: number; checked: number; failed: number };
  publish: { results: boolean; list: boolean; list_coverage: number };
}

/** Research jobs the run seeded, from its `stage_seeded` events of stage research (cards are researched on request, not seeded). */
export function seededResearchJobs(events: ReadonlyArray<{ data: unknown }>): number {
  let n = 0;
  for (const e of events) {
    const d = e.data as { stage?: unknown; jobs?: unknown } | null;
    if (d?.stage === "research" && typeof d.jobs === "number") n += d.jobs;
  }
  return n;
}

export const FX_STALE_DAYS = 4; // A-22

/**
 * list_coverage = (processed + insufficient_data + skipped) / total: a security whose history is too short was evaluated
 * correctly, while failed, stale and unprocessed securities are the gaps (they also make a finished scan "partial").
 * Carried-forward securities and securities of dead exchanges count as unprocessed (7.7): `excluded` removes candidates that were counted
 * as evaluated but are flagged, `extra` adds the owing securities that are not candidates today to the denominator.
 */
export function listCoverage(
  c: Coverage["candidates"],
  adj: { excluded: number; extra: number } = { excluded: 0, extra: 0 },
): number {
  const total = c.total + adj.extra;
  return total === 0 ? 1 : (c.processed + c.insufficient_data + c.skipped - adj.excluded) / total;
}

/**
 * The securities that owe a result but must not count as evaluated: candidates that are carried forward or sit on an exchange whose sweep
 * job is dead (`flagged`), plus carried or dead-exchange previous members that are no candidate today (`extra`).
 */
export function listGaps(a: {
  candidates: ReadonlyArray<{ securityId: string; exchange: string | null }>;
  carriedIds: ReadonlySet<string>;
  previousMembers: ReadonlyArray<{ securityId: string; exchange: string | null }>;
  failedExchanges: ReadonlySet<string>;
}): { flagged: Set<string>; extra: number } {
  const dead = (exchange: string | null) => exchange !== null && a.failedExchanges.has(exchange);
  const candidateIds = new Set(a.candidates.map((c) => c.securityId));
  const flagged = new Set(
    a.candidates
      .filter((c) => a.carriedIds.has(c.securityId) || dead(c.exchange))
      .map((c) => c.securityId),
  );
  const owing = new Set<string>([
    ...a.carriedIds,
    ...a.previousMembers.filter((m) => dead(m.exchange)).map((m) => m.securityId),
  ]);
  let extra = 0;
  for (const id of owing) if (!candidateIds.has(id)) extra += 1;
  return { flagged, extra };
}

export function computeCoverage(i: CoverageInput): Coverage {
  const count = (status: ResultStatus) => i.candidates.filter((c) => c.status === status).length;
  const candidates: Coverage["candidates"] = {
    total: i.candidates.length,
    processed: count("processed"),
    skipped: count("skipped"),
    failed: count("failed"),
    insufficient_data: count("insufficient_data"),
    stale: count("stale"),
    unprocessed: count("unprocessed"),
    carried_forward: i.carriedForward,
  };
  const excluded = i.candidates.filter(
    (c) =>
      c.unprocessed === true &&
      (c.status === "processed" || c.status === "insufficient_data" || c.status === "skipped"),
  ).length;
  const ratio = listCoverage(candidates, { excluded, extra: i.extraUnprocessed ?? 0 });
  const failedExchanges = [...new Set(i.failedExchanges)].sort();
  return {
    universe: {
      exchanges_total: i.exchangesTotal,
      exchanges_ok: Math.max(0, i.exchangesTotal - failedExchanges.length),
      failed_exchanges: failedExchanges,
      raw_rows: i.rawRows,
      companies: i.companies,
    },
    candidates,
    prices: {
      fresh: i.prices.filter((p) => p.freshness === "fresh").length,
      stale: i.prices.filter((p) => p.freshness === "stale").length,
      unavailable: i.prices.filter((p) => p.freshness === "unavailable").length,
      suspect: i.prices.filter((p) => p.suspect).length,
    },
    fx: {
      rate_date: i.fx.rateDate,
      stale: i.fx.rateDay === null || i.fx.scanDay - i.fx.rateDay > FX_STALE_DAYS,
      missing: [...i.fx.missing].sort(),
    },
    research: {
      required: i.research.required,
      complete: 0,
      pending: i.research.required,
      cards: i.research.cards ?? 0,
      quota_deferred: 0,
      failed: 0,
    },
    monitoring: { holdings_monitored: 0, checked: 0, failed: 0 },
    publish: {
      results: true,
      list: ratio >= i.minListCoverage,
      list_coverage: Math.round(ratio * 1000) / 1000,
    },
  };
}
