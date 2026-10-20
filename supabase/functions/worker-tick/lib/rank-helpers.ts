import {
  evaluateTier2,
  type RuleCode,
  shouldCarryForward,
} from "../../_shared/core/eligibility.ts";
import type { Observation } from "../../_shared/core/episodes.ts";
import type { Channel } from "../../_shared/core/indicator.ts";
import {
  applicableDiscountLine,
  type ThresholdLine,
  type UniverseMode,
} from "../../_shared/core/thresholds.ts";

/** One row of a stored universe_snapshots set. */
export interface SnapshotRow {
  mode: UniverseMode;
  securityId: string;
  companyId: string;
  rank: number;
  marketCapUsd: number;
  state: "member" | "carried_forward";
  applicableLine: ThresholdLine;
}

/** Consecutive most-recent snapshots (newest first) in which the security was carried forward in this mode. */
export function leadingCarried(
  history: ReadonlyArray<ReadonlyArray<SnapshotRow>>,
  mode: UniverseMode,
  securityId: string,
): number {
  let n = 0;
  for (const snap of history) {
    const row = snap.find((r) => r.mode === mode && r.securityId === securityId);
    if (row === undefined || row.state !== "carried_forward") break;
    n++;
  }
  return n;
}

export interface CarryPlan {
  carry: Array<{
    mode: UniverseMode;
    securityId: string;
    companyId: string;
    marketCapUsd: number;
    previousRank: number;
  }>;
  dropped: Array<{
    mode: UniverseMode;
    securityId: string;
    companyId: string;
    reason: "data_unavailable" | "carry_limit";
  }>;
}

/**
 * A previous member that cannot be processed today keeps its place for at most `maxScans` consecutive scans (A-02, 7.7).
 * Only data problems carry (missing/stale/unprocessed inputs); a genuine ineligibility is a real removal, and a security that is a
 * member today is never carried (it left a mode legitimately, e.g. it stopped being US-primary).
 * `failedBySecurity`: undefined = no result row today (unprocessed), otherwise the Tier 1 failures.
 * The eligibility of the failure codes is decided by core `shouldCarryForward`; the scan cap comes from the run's settings.
 */
export function planCarryForward(a: {
  previous: ReadonlyArray<SnapshotRow>;
  history: ReadonlyArray<ReadonlyArray<SnapshotRow>>; // newest first, history[0] is `previous`
  memberIds: ReadonlySet<string>;
  failedBySecurity: ReadonlyMap<string, readonly RuleCode[]>;
  maxScans: number;
  /** Rows that must never be carried (non-canonical listing, company already present today): skipped silently, neither carried nor dropped. */
  blocked?: (row: SnapshotRow) => boolean;
}): CarryPlan {
  const plan: CarryPlan = { carry: [], dropped: [] };
  for (const row of a.previous) {
    if (a.memberIds.has(row.securityId)) continue;
    if (a.blocked?.(row) === true) continue;
    const failed = a.failedBySecurity.get(row.securityId);
    const dataProblem = failed === undefined || shouldCarryForward([...failed], 0).carry;
    if (!dataProblem) continue;
    const already = leadingCarried(a.history, row.mode, row.securityId);
    if (already >= a.maxScans) {
      plan.dropped.push({
        mode: row.mode,
        securityId: row.securityId,
        companyId: row.companyId,
        reason: "carry_limit",
      });
    } else {
      plan.carry.push({
        mode: row.mode,
        securityId: row.securityId,
        companyId: row.companyId,
        marketCapUsd: row.marketCapUsd,
        previousRank: row.rank,
      });
    }
  }
  return plan;
}

export interface MembershipEvent {
  mode: UniverseMode;
  companyId: string;
  securityId: string;
  event: "added" | "removed";
  fromRank: number | null;
  toRank: number | null;
  reason: string;
}

/**
 * Diff of the previous list-published snapshot against today's (per mode, per company). Carried-forward rows count as still present
 * and never generate events; a carry that expired shows up as a removal with reason data_unavailable (7.7).
 */
export function membershipEvents(a: {
  previous: ReadonlyArray<SnapshotRow>;
  today: ReadonlyArray<SnapshotRow>;
  reasonFor(event: "added" | "removed", securityId: string, carryExpired: boolean): string;
}): MembershipEvent[] {
  const out: MembershipEvent[] = [];
  for (const mode of ["worldwide", "us"] as const) {
    const prev = new Map(a.previous.filter((r) => r.mode === mode).map((r) => [r.companyId, r]));
    const now = new Map(a.today.filter((r) => r.mode === mode).map((r) => [r.companyId, r]));
    for (const [companyId, row] of now) {
      if (row.state === "member" && !prev.has(companyId)) {
        out.push({
          mode,
          companyId,
          securityId: row.securityId,
          event: "added",
          fromRank: null,
          toRank: row.rank,
          reason: a.reasonFor("added", row.securityId, false),
        });
      }
    }
    for (const [companyId, row] of prev) {
      if (!now.has(companyId)) {
        out.push({
          mode,
          companyId,
          securityId: row.securityId,
          event: "removed",
          fromRank: row.rank,
          toRank: null,
          reason: a.reasonFor("removed", row.securityId, row.state === "carried_forward"),
        });
      }
    }
  }
  return out.sort((x, y) =>
    x.mode < y.mode
      ? -1
      : x.mode > y.mode
        ? 1
        : x.companyId < y.companyId
          ? -1
          : x.companyId > y.companyId
            ? 1
            : x.event < y.event
              ? -1
              : 1,
  );
}

/** Human-meaningful reason code for a membership change (spec 6.3.4 examples). */
export function membershipReason(a: {
  event: "added" | "removed";
  failedNow: readonly RuleCode[] | null; // null = no result row today
  failedBefore: readonly RuleCode[] | null; // null = no result row in the previous scan
  carryExpired: boolean;
}): string {
  const has = (list: readonly RuleCode[] | null, code: RuleCode) =>
    list !== null && list.includes(code);
  if (a.event === "removed") {
    if (a.carryExpired) return "data_unavailable";
    if (a.failedNow === null) return "delisted_or_missing";
    if (has(a.failedNow, "market_cap_below_threshold")) return "market_cap_below_threshold";
    if (has(a.failedNow, "channel_not_rising")) return "channel_not_rising";
    if (has(a.failedNow, "listing_too_new")) return "listing_too_new";
    if (has(a.failedNow, "not_canonical")) return "canonical_changed";
    return a.failedNow[0] ?? "data_unavailable";
  }
  if (a.failedBefore === null) return "new_listing";
  if (has(a.failedBefore, "market_cap_below_threshold")) return "market_cap_above_threshold";
  if (has(a.failedBefore, "channel_not_rising")) return "channel_rising";
  if (has(a.failedBefore, "not_canonical")) return "became_canonical";
  return "requirements_met";
}

export interface SecurityToday {
  sessionDay: number | null;
  close: number | null;
  /** Fresh data, not suspect, channel computed. */
  evaluable: boolean;
  channelEnd: Channel["end"] | null;
  freshness: string;
  tier1Member: boolean;
  carriedForward: boolean;
}

/**
 * Observation of one security in one mode (8.1). lineEnd is null whenever the data is not evaluable, which makes the state machine
 * a no-op: a data failure is never a reset. Returns null when there is no completed close at all.
 */
export function observationFor(a: {
  today: SecurityToday;
  rank: number | null;
  signalGrade: boolean;
}): { obs: Observation; tier2Failed: RuleCode[] } | null {
  const t = a.today;
  if (t.sessionDay === null || t.close === null) return null;
  const applicableLine = applicableDiscountLine(a.rank);
  const lineEnd = t.evaluable && t.channelEnd !== null ? t.channelEnd.lower1 : null;
  const tier2 = evaluateTier2({
    applicableLowerEnd: lineEnd,
    close: t.close,
    freshness: t.freshness,
    signalGrade: a.signalGrade,
  });
  const canOpen = t.evaluable && t.tier1Member && !t.carriedForward && tier2.valid;
  return {
    obs: {
      sessionDay: t.sessionDay,
      close: t.close,
      evaluable: t.evaluable,
      lineEnd,
      canOpen,
      rank: a.rank,
      applicableLine,
    },
    tier2Failed: tier2.failed,
  };
}

/** First entry per securityId, order preserved (a carried security has one carry entry per mode it was ranked in). */
export function uniqueBySecurity<T extends { securityId: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.securityId) && seen.add(i.securityId));
}

/**
 * Tier 1 failures per security for the carry decision and the removal reasons. Securities without a result row today are not all data
 * problems: a previous member whose own market cap snapshot is now below the threshold is a genuine removal (market_cap_below_threshold),
 * and one that is no longer the canonical listing left through a canonical change (not_canonical).
 */
export function failuresForCarry(a: {
  results: ReadonlyMap<string, readonly RuleCode[]>;
  previous: ReadonlyArray<SnapshotRow>;
  memberIds: ReadonlySet<string>;
  snapshotCapUsd: ReadonlyMap<string, number | null>;
  thresholdUsd: number;
  isCanonical(securityId: string): boolean;
}): Map<string, readonly RuleCode[]> {
  const out = new Map<string, readonly RuleCode[]>(a.results);
  for (const row of a.previous) {
    if (a.memberIds.has(row.securityId)) continue;
    if (!a.isCanonical(row.securityId)) {
      out.set(row.securityId, ["not_canonical"]);
      continue;
    }
    if (out.has(row.securityId)) continue;
    const cap = a.snapshotCapUsd.get(row.securityId);
    if (cap !== undefined && cap !== null && cap < a.thresholdUsd)
      out.set(row.securityId, ["market_cap_below_threshold"]);
  }
  return out;
}
