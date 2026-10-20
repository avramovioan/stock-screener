import { evaluateTier2, type RuleCode } from "../../_shared/core/eligibility.ts";
import {
  type ActiveEpisode,
  type EpisodeAction,
  stepDiscount,
} from "../../_shared/core/episodes.ts";
import { assertSignalGradeSettings, type Channel } from "../../_shared/core/indicator.ts";
import {
  isUsPrimary,
  type RankCandidate,
  type RankedRow,
  rankUniverse,
} from "../../_shared/core/ranking.ts";
import {
  applicableDiscountLine,
  lineEnd as lineEndOf,
  type ThresholdLine,
  type UniverseMode,
} from "../../_shared/core/thresholds.ts";
import { computeCoverage, listGaps, type ResultStatus } from "../lib/coverage.ts";
import {
  DbQueryError,
  dayOfDate,
  deadSweepExchanges,
  deleteWhereRun,
  fetchByIds,
  insertChunks,
  loadExchanges,
  selectAll,
  selectCandidates,
} from "../lib/data.ts";
import {
  failuresForCarry,
  membershipEvents,
  membershipReason,
  observationFor,
  planCarryForward,
  type SnapshotRow,
  uniqueBySecurity,
} from "../lib/rank-helpers.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";

const MODES: UniverseMode[] = ["worldwide", "us"];

/**
 * ASSUMPTION (the spec is silent on discount episodes of securities that leave the candidate set, 8.2/7.7 only define membership events):
 * an active episode whose security has no result row in this scan and in the 2 completed scans before it (3 consecutive scans) is closed
 * with reason `left_universe`. Without it the episode stays active for ever and a re-entry months later produces no "new entry".
 */
const LEFT_UNIVERSE_SCANS = 3;

/** Stage 6 `rank_signals` (key `rank`): ranks both modes, evaluates discount episodes, writes snapshots and the technical cards. */
export const seedRankSignals: Seeder = () => Promise.resolve({ keys: ["rank"], priorities: [100] });

interface ResultRow {
  security_id: string;
  status: ResultStatus;
  reason_codes: RuleCode[];
  session_date: string | null;
  close: number | null;
  freshness: "fresh" | "stale" | "unavailable" | null;
  channel: Channel | null;
  market_cap_usd: number | null;
  tier1_member: boolean;
}
interface SecRow {
  id: string;
  company_id: string;
  yahoo_symbol: string;
  exchange_code: string;
  currency: string;
  currency_major: string;
  financial_currency: string | null;
  avg_usd_volume_30d: number | null;
  is_canonical: boolean;
}
interface EpisodeRow {
  id: string;
  security_id: string;
  company_id: string;
  mode: UniverseMode;
  threshold_line: ThresholdLine;
  opened_session_date: string;
  opened_scan_run_id: string;
  last_evaluated_session_date: string;
  rank_history: Array<{ rank: number | null }>;
}
interface PrevSnapshotDb {
  scan_run_id: string;
  mode: UniverseMode;
  security_id: string;
  company_id: string;
  rank: number;
  market_cap_usd: number;
  state: "member" | "carried_forward";
  applicable_line: ThresholdLine;
}

export const handleRankSignals: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const { run } = ctx;
  const { settings } = run;
  assertSignalGradeSettings(settings.indicator); // also checked at scan start; a production scan never runs on custom magnitudes (A-34)

  // ---------------------------------------------------------------- load
  const results = await selectAll<ResultRow>(
    sb,
    "scan_security_results",
    "security_id, status, reason_codes, session_date, close, freshness, channel, market_cap_usd, tier1_member",
    (q) => q.eq("scan_run_id", run.id),
  );
  const resultOf = new Map(results.map((r) => [r.security_id, r]));
  const snaps = await selectAll<{
    security_id: string;
    market_cap_usd: number | null;
    market_cap_native: number | null;
    currency_major: string;
  }>(
    sb,
    "market_cap_snapshots",
    "security_id, market_cap_usd, market_cap_native, currency_major",
    (q) => q.eq("scan_run_id", run.id),
  );
  const snapOf = new Map(snaps.map((s) => [s.security_id, s]));

  const historyRuns =
    ((
      await sb
        .from("scan_runs")
        .select("id")
        .not("list_published_at", "is", null)
        .lt("scan_date_local", run.scanDateLocal)
        .order("scan_date_local", { ascending: false })
        .limit(settings.pipeline.carryForwardMaxScans)
    ).data as Array<{ id: string }> | null) ?? [];
  const historyRaw =
    historyRuns.length === 0
      ? []
      : await fetchByIds<PrevSnapshotDb>(
          sb,
          "universe_snapshots",
          "scan_run_id, mode, security_id, company_id, rank, market_cap_usd, state, applicable_line",
          "scan_run_id",
          historyRuns.map((r) => r.id),
        );
  const toSnapshot = (r: PrevSnapshotDb): SnapshotRow => ({
    mode: r.mode,
    securityId: r.security_id,
    companyId: r.company_id,
    rank: r.rank,
    marketCapUsd: r.market_cap_usd,
    state: r.state,
    applicableLine: r.applicable_line,
  });
  const history: SnapshotRow[][] = historyRuns.map((h) =>
    historyRaw.filter((r) => r.scan_run_id === h.id).map(toSnapshot),
  );
  const previous = history[0] ?? [];
  const priorResults = new Map<string, RuleCode[]>();
  if (historyRuns[0] !== undefined) {
    for (const r of await fetchByIds<{ security_id: string; reason_codes: RuleCode[] }>(
      sb,
      "scan_security_results",
      "security_id, reason_codes",
      "scan_run_id",
      [historyRuns[0].id],
    ))
      priorResults.set(r.security_id, r.reason_codes);
  }

  const episodes = await selectAll<EpisodeRow>(
    sb,
    "signal_episodes",
    "id, security_id, company_id, mode, threshold_line, opened_session_date, opened_scan_run_id, last_evaluated_session_date, rank_history",
    (q) => q.eq("kind", "discount").eq("status", "active"),
  );

  const members = results.filter((r) => r.tier1_member);
  const memberIds = new Set(members.map((m) => m.security_id));
  const allIds = [
    ...new Set([
      ...results.map((r) => r.security_id),
      ...previous.map((r) => r.securityId),
      ...episodes.map((e) => e.security_id),
    ]),
  ];
  const secs = new Map(
    (
      await fetchByIds<SecRow>(
        sb,
        "securities",
        "id, company_id, yahoo_symbol, exchange_code, currency, currency_major, financial_currency, avg_usd_volume_30d, is_canonical",
        "id",
        allIds,
      )
    ).map((s) => [s.id, s]),
  );
  // carry-forward (A-02, 7.7): only a genuine data problem carries. A previous member whose own snapshot fell below the threshold left
  // for a real reason, a security that is no longer canonical left through a canonical change, and a company that already has a member
  // today is never listed twice.
  const failedBySecurity = failuresForCarry({
    results: new Map(results.map((r) => [r.security_id, r.reason_codes])),
    previous,
    memberIds,
    snapshotCapUsd: new Map(snaps.map((x) => [x.security_id, x.market_cap_usd])),
    thresholdUsd: settings.universe.thresholdUsd,
    isCanonical: (id) => secs.get(id)?.is_canonical ?? false,
  });
  const memberCompanies = new Set(
    members
      .map((m) => secs.get(m.security_id)?.company_id)
      .filter((c): c is string => c !== undefined),
  );
  const carry = planCarryForward({
    previous,
    history,
    memberIds,
    failedBySecurity,
    maxScans: settings.pipeline.carryForwardMaxScans,
    blocked: (row) => {
      const company = secs.get(row.securityId)?.company_id;
      return company !== undefined && memberCompanies.has(company);
    },
  });
  const carriedIds = new Set(carry.carry.map((c) => c.securityId));
  const companyIds = [...new Set([...secs.values()].map((s) => s.company_id))];
  const companyCountry = new Map(
    (
      await fetchByIds<{ id: string; country: string | null }>(
        sb,
        "companies",
        "id, country",
        "id",
        companyIds,
      )
    ).map((c) => [c.id, c.country]),
  );
  const siblings = await fetchByIds<{
    id: string;
    company_id: string;
    exchange_code: string;
    avg_usd_volume_30d: number | null;
  }>(
    sb,
    "securities",
    "id, company_id, exchange_code, avg_usd_volume_30d",
    "company_id",
    companyIds,
  );
  const exchanges = await loadExchanges(sb);
  const overrides = new Map(
    (
      await selectAll<{ kind: string; yahoo_symbol: string }>(
        sb,
        "security_identity_overrides",
        "kind, yahoo_symbol",
        (q) => q.eq("active", true),
      )
    )
      .filter((o) => o.kind === "force_us" || o.kind === "force_not_us")
      .map((o) => [o.yahoo_symbol, o.kind as "force_us" | "force_not_us"]),
  );

  // ---------------------------------------------------------------- rank both modes
  const usPrimary = (sec: SecRow): boolean => {
    const home = companyCountry.get(sec.company_id) ?? null;
    const own = sec.avg_usd_volume_30d ?? 0;
    const higher =
      home !== null &&
      siblings.some(
        (o) =>
          o.company_id === sec.company_id &&
          o.id !== sec.id &&
          exchanges.get(o.exchange_code)?.country === home &&
          exchanges.get(o.exchange_code)?.venue_class === "primary" &&
          (o.avg_usd_volume_30d ?? -1) > own,
      );
    return isUsPrimary({
      canonicalExchange: sec.exchange_code,
      financialCurrency: sec.financial_currency,
      homeCountry: home,
      hasHigherVolumeHomeListing: higher,
      override: overrides.get(sec.yahoo_symbol) ?? null,
    });
  };
  const candidateFor = (id: string, capUsd: number): RankCandidate | null => {
    const sec = secs.get(id);
    return sec === undefined
      ? null
      : {
          securityId: id,
          companyId: sec.company_id,
          yahooSymbol: sec.yahoo_symbol,
          marketCapUsd: capUsd,
          isUsPrimary: usPrimary(sec),
        };
  };
  const pool: RankCandidate[] = [];
  for (const m of members) {
    const c = candidateFor(m.security_id, m.market_cap_usd ?? 0);
    if (c !== null) pool.push(c);
  }
  // a security carried in both modes has two carry entries: the pool holds each security once, modes are filtered below
  for (const c of uniqueBySecurity(carry.carry)) {
    const cap = resultOf.get(c.securityId)?.market_cap_usd ?? c.marketCapUsd;
    const cand = candidateFor(c.securityId, cap);
    if (cand !== null) pool.push(cand);
  }
  // carried rows are only carried in the modes they were previously ranked in
  const carriedModes = new Set(carry.carry.map((c) => `${c.mode}:${c.securityId}`));
  const rankedByMode = new Map<UniverseMode, RankedRow[]>();
  for (const mode of MODES) {
    const modePool = pool.filter(
      (c) => !carriedIds.has(c.securityId) || carriedModes.has(`${mode}:${c.securityId}`),
    );
    rankedByMode.set(mode, rankUniverse(modePool, mode));
  }
  const rankOf = (mode: UniverseMode, id: string): number | null =>
    rankedByMode.get(mode)?.find((r) => r.securityId === id)?.rank ?? null;

  // ---------------------------------------------------------------- snapshots (idempotent: delete + insert)
  const snapshotRows: Array<Record<string, unknown>> = [];
  const todayRows: SnapshotRow[] = [];
  for (const mode of MODES) {
    for (const r of rankedByMode.get(mode) ?? []) {
      const res = resultOf.get(r.securityId);
      const line = applicableDiscountLine(r.rank);
      const carried = carriedIds.has(r.securityId);
      const end = !carried && res?.channel ? lineEndOf(res.channel, line) : null;
      const closeV = res?.close ?? null;
      snapshotRows.push({
        scan_run_id: run.id,
        mode,
        security_id: r.securityId,
        company_id: r.companyId,
        rank: r.rank,
        market_cap_usd: r.marketCapUsd,
        is_top10: r.isTop10,
        state: carried ? "carried_forward" : "member",
        applicable_line: line,
        lower_line_end: end,
        close: closeV,
        session_date: res?.session_date ?? null,
        lower_line_positive: end === null ? null : end > 0,
        is_discount: end !== null && closeV !== null && closeV <= end,
      });
      todayRows.push({
        mode,
        securityId: r.securityId,
        companyId: r.companyId,
        rank: r.rank,
        marketCapUsd: r.marketCapUsd,
        state: carried ? "carried_forward" : "member",
        applicableLine: line,
      });
    }
  }
  await deleteWhereRun(sb, "universe_snapshots", run.id);
  await insertChunks(sb, "universe_snapshots", snapshotRows, 500);

  // ---------------------------------------------------------------- episodes
  const active = new Map<string, EpisodeRow>(
    episodes.map((e) => [`${e.mode}:${e.security_id}`, e]),
  );
  let opened = 0;
  let closed = 0;
  let continued = 0;

  // ---------------------------------------------------------------- stale episodes: the security left the candidate set (see LEFT_UNIVERSE_SCANS)
  const stale = episodes.filter((e) => !resultOf.has(e.security_id));
  if (stale.length > 0) {
    const earlier =
      ((
        await sb
          .from("scan_runs")
          .select("id")
          .in("status", ["complete", "partial"])
          .lt("scan_date_local", run.scanDateLocal)
          .order("scan_date_local", { ascending: false })
          .limit(LEFT_UNIVERSE_SCANS - 1)
      ).data as Array<{ id: string }> | null) ?? [];
    if (earlier.length === LEFT_UNIVERSE_SCANS - 1) {
      const seenEarlier = new Set(
        (
          await fetchByIds<{ security_id: string }>(
            sb,
            "scan_security_results",
            "security_id",
            "scan_run_id",
            earlier.map((r) => r.id),
          )
        ).map((r) => r.security_id),
      );
      for (const e of stale) {
        if (seenEarlier.has(e.security_id)) continue;
        const { error } = await sb
          .from("signal_episodes")
          .update({
            status: "closed",
            closed_scan_run_id: run.id,
            closed_session_date: e.last_evaluated_session_date,
            close_reason: "left_universe",
          })
          .eq("id", e.id)
          .eq("status", "active");
        if (error) throw new DbQueryError("signal_episodes.close_left_universe", error.message);
        active.delete(`${e.mode}:${e.security_id}`);
        closed += 1;
        await ctx.log(
          "episode_closed",
          {
            symbol: secs.get(e.security_id)?.yahoo_symbol ?? null,
            mode: e.mode,
            reason: "left_universe",
            line: e.threshold_line,
          },
          { securityId: e.security_id },
        );
      }
    }
  }
  for (const mode of MODES) {
    const evalIds = new Set<string>([
      ...(rankedByMode.get(mode) ?? [])
        .filter((r) => !carriedIds.has(r.securityId))
        .map((r) => r.securityId),
      ...episodes.filter((e) => e.mode === mode).map((e) => e.security_id),
    ]);
    for (const id of [...evalIds].sort()) {
      ctx.signal.throwIfAborted();
      const res = resultOf.get(id);
      const sec = secs.get(id);
      if (res === undefined || sec === undefined || res.session_date === null) continue;
      // evaluable = fresh, not suspect and the channel computed for this session (8.1/8.3); otherwise the step is a not_evaluable noop
      const evaluable =
        res.freshness === "fresh" &&
        res.status === "processed" &&
        !res.reason_codes.includes("suspect_data") &&
        res.channel !== null;
      const observed = observationFor({
        today: {
          sessionDay: dayOfDate(res.session_date),
          close: res.close,
          evaluable,
          channelEnd: res.channel?.end ?? null,
          freshness: res.freshness ?? "unavailable",
          tier1Member: res.tier1_member,
          carriedForward: carriedIds.has(id),
        },
        rank: rankOf(mode, id),
        signalGrade: true,
      });
      if (observed === null) continue;
      const row = active.get(`${mode}:${id}`);
      const activeEpisode: ActiveEpisode | null =
        row === undefined
          ? null
          : {
              id: row.id,
              kind: "discount",
              mode,
              line: row.threshold_line,
              openedSessionDay: dayOfDate(row.opened_session_date),
              lastEvaluatedSessionDay: dayOfDate(row.last_evaluated_session_date),
            };
      const actions: EpisodeAction[] = stepDiscount(activeEpisode, observed.obs);
      const openDoc = (action: Extract<EpisodeAction, { type: "open" }>) => {
        const rank = rankOf(mode, id);
        return {
          security_id: id,
          company_id: sec.company_id,
          kind: "discount",
          mode,
          threshold_line: action.line,
          opened_scan_run_id: run.id,
          opened_session_date: res.session_date,
          opened_close: res.close,
          opened_line_value: observed.obs.lineEnd,
          opened_rank: rank,
          open_reason: action.reason,
          continues_episode_id: action.continuesEpisodeId ?? null,
          notify: action.notify,
          last_evaluated_session_date: res.session_date,
          rank_history: [
            { scan_run_id: run.id, session_date: res.session_date, rank, line: action.line },
          ],
        };
      };
      for (let ai = 0; ai < actions.length; ai++) {
        const action = actions[ai] as EpisodeAction;
        const next = actions[ai + 1];
        if (action.type === "close" && row !== undefined && next?.type === "open") {
          // threshold change: close and silent continuation in ONE transaction, so a retry can never open a second, notifying episode (8.4)
          const { data, error } = await sb.schema("app").rpc("transition_episode", {
            p_close_id: row.id,
            p_close_reason: action.reason,
            p_session_day: res.session_date,
            p_open: openDoc(next),
          });
          if (error) throw new DbQueryError("transition_episode", error.message);
          active.set(`${mode}:${id}`, data as EpisodeRow);
          closed += 1;
          opened += 1;
          if (next.reason === "continuation") continued += 1;
          ai += 1;
          await ctx.log(
            "episode_closed",
            { symbol: sec.yahoo_symbol, mode, reason: action.reason, line: row.threshold_line },
            { securityId: id },
          );
          await ctx.log(
            "episode_opened",
            {
              symbol: sec.yahoo_symbol,
              mode,
              line: next.line,
              reason: next.reason,
              notify: next.notify,
              rank: rankOf(mode, id),
            },
            { securityId: id },
          );
        } else if (action.type === "close" && row !== undefined) {
          const { error } = await sb
            .from("signal_episodes")
            .update({
              status: "closed",
              closed_scan_run_id: run.id,
              closed_session_date: res.session_date,
              close_reason: action.reason,
              last_evaluated_session_date: res.session_date,
            })
            .eq("id", row.id)
            .eq("status", "active");
          if (error) throw new DbQueryError("signal_episodes.close", error.message);
          active.delete(`${mode}:${id}`);
          closed += 1;
          await ctx.log(
            "episode_closed",
            { symbol: sec.yahoo_symbol, mode, reason: action.reason, line: row.threshold_line },
            { securityId: id },
          );
        } else if (action.type === "open") {
          const rank = rankOf(mode, id);
          const insert = openDoc(action);
          const { data, error } = await sb
            .from("signal_episodes")
            .insert(insert)
            .select(
              "id, security_id, company_id, mode, threshold_line, opened_session_date, opened_scan_run_id, last_evaluated_session_date, rank_history",
            )
            .single();
          if (error) throw new DbQueryError("signal_episodes.open", error.message);
          active.set(`${mode}:${id}`, data as EpisodeRow);
          opened += 1;
          if (action.reason === "continuation") continued += 1;
          await ctx.log(
            "episode_opened",
            {
              symbol: sec.yahoo_symbol,
              mode,
              line: action.line,
              reason: action.reason,
              notify: action.notify,
              rank,
            },
            { securityId: id },
          );
        } else if (
          action.type === "noop" &&
          row !== undefined &&
          observed.obs.lineEnd !== null &&
          res.session_date > row.last_evaluated_session_date
        ) {
          const rank = rankOf(mode, id);
          const last = row.rank_history[row.rank_history.length - 1];
          const patch: Record<string, unknown> = { last_evaluated_session_date: res.session_date };
          if (last === undefined || last.rank !== rank)
            patch["rank_history"] = [
              ...row.rank_history,
              {
                scan_run_id: run.id,
                session_date: res.session_date,
                rank,
                line: row.threshold_line,
              },
            ];
          const { error } = await sb.from("signal_episodes").update(patch).eq("id", row.id);
          if (error) throw new DbQueryError("signal_episodes.touch", error.message);
        }
      }
    }
  }

  // ---------------------------------------------------------------- today's discounts (technical part; research is pending until P2)
  const cards: Array<Record<string, unknown>> = [];
  for (const [key, ep] of active) {
    const [mode, id] = [
      key.slice(0, key.indexOf(":")) as UniverseMode,
      key.slice(key.indexOf(":") + 1),
    ];
    const res = resultOf.get(id);
    const sec = secs.get(id);
    const rank = rankOf(mode, id);
    if (
      res === undefined ||
      sec === undefined ||
      res.channel === null ||
      res.close === null ||
      res.session_date === null ||
      rank === null ||
      carriedIds.has(id) ||
      !res.tier1_member
    )
      continue;
    if (res.freshness !== "fresh" || res.reason_codes.includes("suspect_data")) continue;
    // every discount card shows the -3 line end (A-51); the -4 end is read from the stored channel by the feed view
    const lowerEnd = res.channel.end.lower1;
    const tier2 = evaluateTier2({
      applicableLowerEnd: lowerEnd,
      close: res.close,
      freshness: res.freshness,
      signalGrade: true,
    });
    const snap = snapOf.get(id);
    cards.push({
      scan_run_id: run.id,
      mode,
      security_id: id,
      company_id: ep.company_id,
      episode_id: ep.id,
      is_new_episode: ep.opened_scan_run_id === run.id,
      rank,
      market_cap_usd: res.market_cap_usd,
      market_cap_native: snap?.market_cap_native ?? null,
      market_cap_ccy: snap?.currency_major ?? sec.currency_major,
      close: res.close,
      currency: sec.currency,
      session_date: res.session_date,
      threshold_line: ep.threshold_line,
      lower_line_end: lowerEnd,
      channel: res.channel,
      trend_ok: res.channel.rising,
      eligibility: {
        tier1: { member: res.tier1_member, failed: res.reason_codes },
        tier2: { valid: tier2.valid, failed: tier2.failed },
      },
      operational_category: "pending",
      category_reason: "research_pending",
      data_freshness: res.freshness,
      display_order: rank,
      withheld: true,
    });
  }
  await deleteWhereRun(sb, "todays_discounts", run.id);
  await insertChunks(sb, "todays_discounts", cards, 100);

  // ---------------------------------------------------------------- run-level facts
  const bySession = new Map<string, string>();
  for (const r of results) {
    const ex = secs.get(r.security_id)?.exchange_code;
    if (ex !== undefined && r.session_date !== null && (bySession.get(ex) ?? "") < r.session_date)
      bySession.set(ex, r.session_date);
  }
  const latest = [...bySession.values()].sort().at(-1) ?? null;
  const sizes = Object.fromEntries(
    MODES.map((m) => [
      m,
      {
        members: (rankedByMode.get(m) ?? []).filter((r) => !carriedIds.has(r.securityId)).length,
        carried_forward: (rankedByMode.get(m) ?? []).filter((r) => carriedIds.has(r.securityId))
          .length,
      },
    ]),
  );
  const { error: runErr } = await sb
    .from("scan_runs")
    .update({
      universe_sizes: sizes,
      session_dates: Object.fromEntries(bySession),
      latest_session_date: latest,
    })
    .eq("id", run.id);
  if (runErr) throw new DbQueryError("scan_runs.update", runErr.message);

  // ---------------------------------------------------------------- membership events (list-published snapshots only, 7.7)
  const candidates = await selectCandidates(sb, run.id, settings.universe.thresholdUsd);
  const gaps = listGaps({
    candidates: candidates.map((c) => ({
      securityId: c.securityId,
      exchange: secs.get(c.securityId)?.exchange_code ?? null,
    })),
    carriedIds,
    previousMembers: previous.map((r) => ({
      securityId: r.securityId,
      exchange: secs.get(r.securityId)?.exchange_code ?? null,
    })),
    failedExchanges: new Set(await deadSweepExchanges(sb, run.id)),
  });
  const statuses = candidates.map((c) => ({
    status: (resultOf.get(c.securityId)?.status ?? "unprocessed") as ResultStatus,
    unprocessed: gaps.flagged.has(c.securityId),
  }));
  const coverage = computeCoverage({
    exchangesTotal: 0,
    failedExchanges: [],
    rawRows: 0,
    companies: 0,
    candidates: statuses,
    extraUnprocessed: gaps.extra,
    carriedForward: carriedIds.size,
    prices: [],
    fx: { rateDate: null, scanDay: run.scanDay, rateDay: null, missing: [] },
    research: { required: 0 },
    minListCoverage: settings.pipeline.listPublishMinCoverage,
  });
  let events = 0;
  await deleteWhereRun(sb, "universe_membership_events", run.id);
  if (coverage.publish.list && historyRuns.length > 0) {
    const diff = membershipEvents({
      previous,
      today: todayRows,
      reasonFor: (event, id, expired) =>
        membershipReason({
          event,
          failedNow: failedBySecurity.get(id) ?? null,
          failedBefore: priorResults.get(id) ?? null,
          carryExpired: expired,
        }),
    });
    await insertChunks(
      sb,
      "universe_membership_events",
      diff.map((e) => ({
        scan_run_id: run.id,
        event_date: run.scanDateLocal,
        mode: e.mode,
        company_id: e.companyId,
        security_id: e.securityId,
        event: e.event,
        from_rank: e.fromRank,
        to_rank: e.toRank,
        reason: e.reason,
      })),
      300,
    );
    events = diff.length;
  }
  return {
    members: members.length,
    carried: carry.carry.length,
    dropped: carry.dropped.length,
    ranked: Object.fromEntries(MODES.map((m) => [m, rankedByMode.get(m)?.length ?? 0])),
    episodes: { opened, closed, continued, active: active.size },
    cards: cards.length,
    membershipEvents: events,
    listCoverage: coverage.publish.list_coverage,
  };
};
