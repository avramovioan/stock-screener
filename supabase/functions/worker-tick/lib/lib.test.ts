import { assert, assertEquals, assertThrows } from "@std/assert";
import { dayNumber } from "../../_shared/core/calendar.ts";
import type { RuleCode } from "../../_shared/core/eligibility.ts";
import type { Channel } from "../../_shared/core/indicator.ts";
import { batchPlan, chunk, exchangeOfSweepKey, parseSweepKey, sweepKey } from "./batching.ts";
import {
  type CoverageInput,
  computeCoverage,
  listCoverage,
  listGaps,
  type ResultStatus,
  seededResearchJobs,
} from "./coverage.ts";
import {
  failuresForCarry,
  leadingCarried,
  membershipEvents,
  membershipReason,
  observationFor,
  planCarryForward,
  type SnapshotRow,
  uniqueBySecurity,
} from "./rank-helpers.ts";
import { hashWindow, rowFromSeries, sameSeries, seriesFromRow } from "./series.ts";

// ------------------------------------------------------------------------------------------------ batching

Deno.test("batchPlan: 25 securities per compute job and 12 per fetch job, stable keys and payloads", () => {
  const ids = Array.from({ length: 53 }, (_, i) => `s${i}`);
  const compute = batchPlan("compute", ids, 25);
  assertEquals(compute.keys, ["compute:0", "compute:1", "compute:2"]);
  assertEquals(
    (compute.payloads as Array<{ securityIds: string[] }>).map((p) => p.securityIds.length),
    [25, 25, 3],
  );
  const bars = batchPlan("bars", ids, 12);
  assertEquals(bars.keys.length, 5);
  assertEquals(batchPlan("bars", [], 12), { keys: [], payloads: [], priorities: [] });
});

Deno.test("chunk rejects a non-positive size", () => {
  assertThrows(() => chunk([1], 0), RangeError);
});

Deno.test("sweep keys: the first page uses the bare code, follow-ups carry the offset, recheck is its own job", () => {
  assertEquals(sweepKey("NMS", 0), "NMS");
  assertEquals(sweepKey("NMS", 2500), "NMS@2500");
  assertEquals(parseSweepKey("NMS@2500"), { kind: "exchange", code: "NMS", offset: 2500 });
  assertEquals(parseSweepKey("GER"), { kind: "exchange", code: "GER", offset: 0 });
  assertEquals(parseSweepKey("recheck:0"), { kind: "recheck" });
  assertEquals(exchangeOfSweepKey("SAU@250"), "SAU");
  assertEquals(exchangeOfSweepKey("recheck:0"), null);
});

// ------------------------------------------------------------------------------------------------ coverage

const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  exchangesTotal: 28,
  failedExchanges: [],
  rawRows: 700,
  companies: 480,
  candidates: [],
  carriedForward: 0,
  prices: [],
  fx: {
    rateDate: "2026-10-14",
    scanDay: dayNumber(2026, 10, 15),
    rateDay: dayNumber(2026, 10, 14),
    missing: [],
  },
  research: { required: 0 },
  minListCoverage: 0.95,
  ...over,
});
const cands = (spec: Partial<Record<ResultStatus, number>>) =>
  (Object.entries(spec) as Array<[ResultStatus, number]>).flatMap(([status, n]) =>
    Array.from({ length: n }, () => ({ status })),
  );

Deno.test("computeCoverage: counts every status and publishes the list at >= 95%", () => {
  const c = computeCoverage(
    base({
      candidates: cands({
        processed: 590,
        skipped: 4,
        failed: 8,
        insufficient_data: 3,
        stale: 4,
        unprocessed: 3,
      }),
      carriedForward: 4,
    }),
  );
  assertEquals(c.candidates, {
    total: 612,
    processed: 590,
    skipped: 4,
    failed: 8,
    insufficient_data: 3,
    stale: 4,
    unprocessed: 3,
    carried_forward: 4,
  });
  assertEquals(c.publish.list_coverage, Math.round(((590 + 3 + 4) / 612) * 1000) / 1000);
  assertEquals(c.publish.list, true);
  assertEquals(c.publish.results, true);
});

Deno.test("computeCoverage: the list is withheld below 95% (unprocessed securities are gaps, never passes)", () => {
  const c = computeCoverage(
    base({ candidates: cands({ processed: 90, failed: 6, unprocessed: 4 }) }),
  );
  assertEquals(c.publish.list, false);
  assertEquals(c.publish.list_coverage, 0.9);
});

Deno.test("computeCoverage: exactly 95% publishes, 94.9% does not", () => {
  assertEquals(
    computeCoverage(base({ candidates: cands({ processed: 95, failed: 5 }) })).publish.list,
    true,
  );
  assertEquals(
    computeCoverage(base({ candidates: cands({ processed: 949, failed: 51 }) })).publish.list,
    false,
  );
});

Deno.test("listCoverage of an empty candidate set is 1 (nothing to process)", () => {
  assertEquals(listCoverage(computeCoverage(base()).candidates), 1);
});

Deno.test("computeCoverage: failed exchanges are listed once, sorted, and reduce exchanges_ok", () => {
  const c = computeCoverage(base({ failedExchanges: ["SAU", "GER", "SAU"] }));
  assertEquals(c.universe, {
    exchanges_total: 28,
    exchanges_ok: 26,
    failed_exchanges: ["GER", "SAU"],
    raw_rows: 700,
    companies: 480,
  });
});

Deno.test("computeCoverage: price freshness, suspect count and FX staleness", () => {
  const c = computeCoverage(
    base({
      prices: [
        { freshness: "fresh", suspect: false },
        { freshness: "fresh", suspect: true },
        { freshness: "stale", suspect: false },
        { freshness: "unavailable", suspect: false },
      ],
      fx: {
        rateDate: "2026-10-10",
        scanDay: dayNumber(2026, 10, 15),
        rateDay: dayNumber(2026, 10, 10),
        missing: ["TWD", "SAR"],
      },
    }),
  );
  assertEquals(c.prices, { fresh: 2, stale: 1, unavailable: 1, suspect: 1 });
  assertEquals(c.fx, { rate_date: "2026-10-10", stale: true, missing: ["SAR", "TWD"] });
  assertEquals(
    computeCoverage(
      base({
        fx: {
          rateDate: "2026-10-11",
          scanDay: dayNumber(2026, 10, 15),
          rateDay: dayNumber(2026, 10, 11),
          missing: [],
        },
      }),
    ).fx.stale,
    false,
  );
  assertEquals(
    computeCoverage(base({ fx: { rateDate: null, scanDay: 1, rateDay: null, missing: [] } })).fx
      .stale,
    true,
  );
});

Deno.test("computeCoverage: research is reported as pending in P1", () => {
  assertEquals(computeCoverage(base({ research: { required: 3 } })).research, {
    required: 3,
    complete: 0,
    pending: 3,
    cards: 0,
    quota_deferred: 0,
    failed: 0,
  });
});

// ------------------------------------------------------------------------------------------------ series

Deno.test("rowFromSeries: dates, denormalised closes and integer volumes; empty series is refused", () => {
  const series = {
    dates: [dayNumber(2026, 10, 13), dayNumber(2026, 10, 14)],
    open: [1, 2],
    high: [2, 3],
    low: [0.5, 1.5],
    close: [1.5, 2.5],
    volume: [10.4, 20],
  };
  const row = rowFromSeries({
    securityId: "s1",
    series,
    completeness: { validBars: 2 },
    freshness: "fresh",
    nowIso: "2026-10-15T07:00:00.000Z",
    lastFullRefreshIso: "2026-10-15T07:00:00.000Z",
  });
  assertEquals(
    [
      row["bar_count"],
      row["first_bar_date"],
      row["last_bar_date"],
      row["last_session_date"],
      row["last_close"],
      row["prev_close"],
    ],
    [2, "2026-10-13", "2026-10-14", "2026-10-14", 2.5, 1.5],
  );
  assertEquals(row["volume"], [10, 20]);
  assertThrows(
    () =>
      rowFromSeries({
        securityId: "s1",
        series: { dates: [], open: [], high: [], low: [], close: [], volume: [] },
        completeness: {},
        freshness: "fresh",
        nowIso: "",
        lastFullRefreshIso: "",
      }),
    RangeError,
  );
});

Deno.test("seriesFromRow copies the arrays", () => {
  const row = { bar_dates: [1], open: [1], high: [1], low: [1], close: [1], volume: [1] };
  const s = seriesFromRow(row);
  s.close[0] = 9;
  assertEquals(row.close[0], 1);
});

Deno.test("hashWindow: stable, sensitive to the window, insensitive to bars before it", async () => {
  const a = { close: [1, 2, 3, 4], high: [2, 3, 4, 5], low: [0, 1, 2, 3] };
  const h = await hashWindow(a, 3);
  assertEquals(h.length, 64);
  assertEquals(
    await hashWindow({ close: [9, 2, 3, 4], high: [9, 3, 4, 5], low: [9, 1, 2, 3] }, 3),
    h,
  );
  assert((await hashWindow({ close: [1, 2, 3, 4.0001], high: a.high, low: a.low }, 3)) !== h);
});

// ------------------------------------------------------------------------------------------------ carry forward

const snap = (
  mode: "worldwide" | "us",
  id: string,
  state: "member" | "carried_forward" = "member",
  rank = 1,
): SnapshotRow => ({
  mode,
  securityId: id,
  companyId: `c-${id}`,
  rank,
  marketCapUsd: 100e9,
  state,
  applicableLine: "-3",
});

Deno.test("planCarryForward: a missing result carries for 3 consecutive scans and is dropped on the 4th", () => {
  const maxScans = 3;
  const plan = (history: SnapshotRow[][]) =>
    planCarryForward({
      previous: history[0] as SnapshotRow[],
      history,
      memberIds: new Set(),
      failedBySecurity: new Map(),
      maxScans,
    });
  // scan 1 without data: previous row is a plain member -> carried (count becomes 1)
  assertEquals(
    plan([[snap("worldwide", "a")]]).carry.map((c) => c.securityId),
    ["a"],
  );
  // scan 2: previous carried once -> carried again
  assertEquals(
    plan([[snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a")]]).carry.length,
    1,
  );
  // scan 3: carried twice -> carried a third time
  assertEquals(
    plan([
      [snap("worldwide", "a", "carried_forward")],
      [snap("worldwide", "a", "carried_forward")],
      [snap("worldwide", "a")],
    ]).carry.length,
    1,
  );
  // scan 4: carried three times already -> dropped
  const fourth = plan([
    [snap("worldwide", "a", "carried_forward")],
    [snap("worldwide", "a", "carried_forward")],
    [snap("worldwide", "a", "carried_forward")],
  ]);
  assertEquals(fourth.carry, []);
  assertEquals(
    fourth.dropped.map((d) => [d.securityId, d.reason]),
    [["a", "carry_limit"]],
  );
});

Deno.test("planCarryForward: only data problems carry; genuine ineligibility and current members do not", () => {
  const previous = [
    snap("worldwide", "stale"),
    snap("worldwide", "small"),
    snap("worldwide", "member"),
    snap("us", "us-only"),
  ];
  const failedBySecurity = new Map<string, RuleCode[]>([
    ["stale", ["market_cap_stale", "stale_data"]],
    ["small", ["market_cap_below_threshold"]],
    ["us-only", ["fx_missing"]],
  ]);
  const plan = planCarryForward({
    previous,
    history: [previous],
    memberIds: new Set(["member"]),
    failedBySecurity,
    maxScans: 3,
  });
  assertEquals(
    plan.carry.map((c) => `${c.mode}:${c.securityId}`),
    ["worldwide:stale", "us:us-only"],
  );
  assertEquals(plan.dropped, []);
});

Deno.test("leadingCarried counts only the unbroken newest run of carried states", () => {
  const h = [
    [snap("worldwide", "a", "carried_forward")],
    [snap("worldwide", "a", "member")],
    [snap("worldwide", "a", "carried_forward")],
  ];
  assertEquals(leadingCarried(h, "worldwide", "a"), 1);
  assertEquals(leadingCarried(h, "us", "a"), 0);
  assertEquals(leadingCarried([], "worldwide", "a"), 0);
});

// ------------------------------------------------------------------------------------------------ membership events

Deno.test("membershipEvents: added and removed per mode; carried rows are present but silent", () => {
  const previous = [
    snap("worldwide", "keep", "member", 1),
    snap("worldwide", "gone", "member", 2),
    snap("worldwide", "was-carried", "carried_forward", 3),
    snap("worldwide", "expired", "carried_forward", 4),
  ];
  const today = [
    snap("worldwide", "keep", "member", 1),
    snap("worldwide", "new", "member", 2),
    snap("worldwide", "was-carried", "member", 3),
    snap("worldwide", "now-carried", "carried_forward", 5),
  ];
  const events = membershipEvents({
    previous,
    today,
    reasonFor: (event, id, expired) => `${event}:${id}:${expired}`,
  });
  assertEquals(
    events.map((e) => `${e.mode}:${e.event}:${e.securityId}:${e.reason}`),
    [
      "worldwide:removed:expired:removed:expired:true",
      "worldwide:removed:gone:removed:gone:false",
      "worldwide:added:new:added:new:false",
    ],
  ); // ordered by mode, company id, event
  const removed = events.find((e) => e.securityId === "gone");
  assertEquals([removed?.fromRank, removed?.toRank], [2, null]);
  const added = events.find((e) => e.securityId === "new");
  assertEquals([added?.fromRank, added?.toRank], [null, 2]);
});

Deno.test("membershipEvents: modes are independent", () => {
  const previous = [snap("worldwide", "a"), snap("us", "a")];
  const today = [snap("worldwide", "a")];
  const events = membershipEvents({ previous, today, reasonFor: () => "x" });
  assertEquals(
    events.map((e) => `${e.mode}:${e.event}`),
    ["us:removed"],
  );
});

Deno.test("membershipEvents: no previous snapshot means every member is added, so callers skip the baseline run", () => {
  assertEquals(
    membershipEvents({ previous: [], today: [snap("worldwide", "a")], reasonFor: () => "x" })
      .length,
    1,
  );
});

Deno.test("membershipReason maps rule failures to readable reasons", () => {
  assertEquals(
    membershipReason({
      event: "removed",
      failedNow: ["market_cap_below_threshold"],
      failedBefore: [],
      carryExpired: false,
    }),
    "market_cap_below_threshold",
  );
  assertEquals(
    membershipReason({
      event: "removed",
      failedNow: ["channel_not_rising"],
      failedBefore: [],
      carryExpired: false,
    }),
    "channel_not_rising",
  );
  assertEquals(
    membershipReason({ event: "removed", failedNow: null, failedBefore: [], carryExpired: false }),
    "delisted_or_missing",
  );
  assertEquals(
    membershipReason({
      event: "removed",
      failedNow: ["stale_data"],
      failedBefore: [],
      carryExpired: true,
    }),
    "data_unavailable",
  );
  assertEquals(
    membershipReason({
      event: "removed",
      failedNow: ["suspect_data"],
      failedBefore: [],
      carryExpired: false,
    }),
    "suspect_data",
  );
  assertEquals(
    membershipReason({ event: "added", failedNow: [], failedBefore: null, carryExpired: false }),
    "new_listing",
  );
  assertEquals(
    membershipReason({
      event: "added",
      failedNow: [],
      failedBefore: ["market_cap_below_threshold"],
      carryExpired: false,
    }),
    "market_cap_above_threshold",
  );
  assertEquals(
    membershipReason({
      event: "added",
      failedNow: [],
      failedBefore: ["channel_not_rising"],
      carryExpired: false,
    }),
    "channel_rising",
  );
  assertEquals(
    membershipReason({
      event: "added",
      failedNow: [],
      failedBefore: ["insufficient_bars"],
      carryExpired: false,
    }),
    "requirements_met",
  );
});

// ------------------------------------------------------------------------------------------------ observations

const end: Channel["end"] = { base: 100, upper1: 110, upper2: 120, lower1: 90, lower2: 80 };
const today = (over: Record<string, unknown> = {}) =>
  ({
    sessionDay: dayNumber(2026, 10, 14),
    close: 85,
    evaluable: true,
    channelEnd: end,
    freshness: "fresh",
    tier1Member: true,
    carriedForward: false,
    ...over,
  }) as Parameters<typeof observationFor>[0]["today"];

Deno.test("observationFor: every rank (5, 11, 40, none) triggers on the -3 line (90), never on -4 (A-51)", () => {
  for (const rank of [5, 11, 40, null]) {
    const r = observationFor({ today: today(), rank, signalGrade: true })!;
    assertEquals(
      [r.obs.applicableLine, r.obs.lineEnd, r.obs.canOpen],
      ["-3", 90, true],
      `rank ${rank}`,
    );
  }
});

Deno.test("observationFor: a lower line at or below zero cannot open (Tier 2), but the observation stays evaluable", () => {
  const r = observationFor({
    today: today({ channelEnd: { ...end, lower1: -0.5 } }),
    rank: 5,
    signalGrade: true,
  })!;
  assertEquals(r.obs.canOpen, false);
  assertEquals(r.obs.lineEnd, -0.5);
  assertEquals(r.tier2Failed, ["lower_line_not_positive"]);
});

Deno.test("observationFor: stale or suspect data has no line end (a data failure is never a reset)", () => {
  const r = observationFor({
    today: today({ evaluable: false, freshness: "stale" }),
    rank: 5,
    signalGrade: true,
  })!;
  assertEquals([r.obs.lineEnd, r.obs.canOpen], [null, false]);
});

Deno.test("observationFor: carried-forward, non-member and non-signal-grade securities cannot open", () => {
  assertEquals(
    observationFor({
      today: today({ carriedForward: true }),
      rank: 5,
      signalGrade: true,
    })!.obs.canOpen,
    false,
  );
  assertEquals(
    observationFor({
      today: today({ tier1Member: false }),
      rank: null,
      signalGrade: true,
    })!.obs.canOpen,
    false,
  );
  assertEquals(observationFor({ today: today(), rank: 5, signalGrade: false })!.obs.canOpen, false);
});

Deno.test("observationFor: no completed close means no observation", () => {
  assertEquals(
    observationFor({
      today: today({ close: null }),
      rank: 5,
      signalGrade: true,
    }),
    null,
  );
  assertEquals(
    observationFor({
      today: today({ sessionDay: null }),
      rank: 5,
      signalGrade: true,
    }),
    null,
  );
});

Deno.test("sameSeries tolerates the 15-digit float round trip of PostgREST but not a real change", () => {
  const a = {
    dates: [1, 2],
    open: [1.1234567890123457, 2],
    high: [2, 3],
    low: [0.5, 1],
    close: [1.1234567890123457, 2.5],
    volume: [10, 20],
  };
  const lossy = { ...a, close: [1.12345678901235, 2.5], open: [1.12345678901235, 2] };
  assert(sameSeries(a, lossy));
  assert(!sameSeries(a, { ...a, close: [1.1234568, 2.5] }));
  assert(!sameSeries(a, { ...a, volume: [10, 21] }));
  assert(!sameSeries(a, { ...a, dates: [1, 3] }));
});

Deno.test("uniqueBySecurity keeps the first entry per security (a carried security has one carry entry per mode)", () => {
  const carry = [
    { mode: "worldwide", securityId: "a", n: 1 },
    { mode: "us", securityId: "a", n: 2 },
    { mode: "worldwide", securityId: "b", n: 3 },
  ];
  assertEquals(
    uniqueBySecurity(carry).map((c) => c.n),
    [1, 3],
  );
});

// ------------------------------------------------------------------------------------------------ review fixes (I2, I3)

Deno.test("failuresForCarry: a previous member whose own snapshot fell below the threshold is a genuine removal, not a data gap", () => {
  const previous = [
    snap("worldwide", "small"),
    snap("worldwide", "unknown-cap"),
    snap("worldwide", "no-snapshot"),
  ];
  const failed = failuresForCarry({
    results: new Map(),
    previous,
    memberIds: new Set(),
    snapshotCapUsd: new Map<string, number | null>([
      ["small", 30e9],
      ["unknown-cap", null],
    ]),
    thresholdUsd: 50e9,
    isCanonical: () => true,
  });
  assertEquals(failed.get("small"), ["market_cap_below_threshold"]);
  assertEquals(failed.has("unknown-cap"), false);
  assertEquals(failed.has("no-snapshot"), false);
  const plan = planCarryForward({
    previous,
    history: [previous],
    memberIds: new Set(),
    failedBySecurity: failed,
    maxScans: 3,
  });
  assertEquals(
    plan.carry.map((c) => c.securityId),
    ["unknown-cap", "no-snapshot"],
  ); // only the real data gaps carry
  assertEquals(
    membershipReason({
      event: "removed",
      failedNow: failed.get("small") ?? null,
      failedBefore: [],
      carryExpired: false,
    }),
    "market_cap_below_threshold",
  );
});

Deno.test("canonical switch A -> B: the old listing is neither carried nor a second member of the company", () => {
  const previous = [snap("worldwide", "A"), snap("us", "A")];
  const failed = failuresForCarry({
    results: new Map(),
    previous,
    memberIds: new Set(["B"]),
    snapshotCapUsd: new Map(),
    thresholdUsd: 50e9,
    isCanonical: (id) => id !== "A",
  });
  assertEquals(failed.get("A"), ["not_canonical"]);
  const plan = planCarryForward({
    previous,
    history: [previous],
    memberIds: new Set(["B"]),
    failedBySecurity: failed,
    maxScans: 3,
  });
  assertEquals(plan.carry, []);
  // even when the old listing is canonical-flagged but its company already has a member today it is skipped silently
  const blockedPlan = planCarryForward({
    previous,
    history: [previous],
    memberIds: new Set(["B"]),
    failedBySecurity: new Map(),
    maxScans: 3,
    blocked: (row) => row.companyId === "c-A",
  });
  assertEquals([blockedPlan.carry, blockedPlan.dropped], [[], []]);
});

Deno.test("list coverage: a dead exchange with 10% of the previous members does not publish the list", () => {
  const previousMembers = [
    ...Array.from({ length: 90 }, (_, i) => ({ securityId: `ok${i}`, exchange: "NMS" })),
    ...Array.from({ length: 10 }, (_, i) => ({ securityId: `dead${i}`, exchange: "SAU" })),
  ];
  const candidates = previousMembers.filter((m) => m.exchange === "NMS");
  const gaps = listGaps({
    candidates,
    carriedIds: new Set(),
    previousMembers,
    failedExchanges: new Set(["SAU"]),
  });
  assertEquals([gaps.flagged.size, gaps.extra], [0, 10]);
  const c = computeCoverage(
    base({
      candidates: candidates.map(() => ({ status: "processed" as const })),
      extraUnprocessed: gaps.extra,
    }),
  );
  assertEquals(c.publish.list_coverage, 0.9);
  assertEquals(c.publish.list, false);
  // without the dead exchange being counted the list would have been published with 100%
  assertEquals(
    computeCoverage(base({ candidates: candidates.map(() => ({ status: "processed" as const })) }))
      .publish.list,
    true,
  );
});

Deno.test("list coverage: carried-forward candidates count as unprocessed whatever their status", () => {
  const candidates = [
    ...Array.from({ length: 18 }, () => ({ status: "processed" as const })),
    { status: "processed" as const, unprocessed: true },
    { status: "insufficient_data" as const, unprocessed: true },
  ];
  const c = computeCoverage(base({ candidates, carriedForward: 2 }));
  assertEquals(c.publish.list_coverage, 0.9);
  assertEquals(c.publish.list, false);
  const gaps = listGaps({
    candidates: [{ securityId: "a", exchange: "NMS" }],
    carriedIds: new Set(["a", "b"]),
    previousMembers: [],
    failedExchanges: new Set(),
  });
  assertEquals([[...gaps.flagged], gaps.extra], [["a"], 1]);
});

// ------------------------------------------------------------------------------------------------ deterministic paging (final fix wave A)

Deno.test("selectAll, fetchByIds and loadExchanges page in primary-key order", async () => {
  const { createFakeSb } = await import("../testing/fake-sb.ts");
  const { selectAll, fetchByIds, loadExchanges } = await import("./data.ts");
  const sb = createFakeSb({
    securities: [{ id: "c" }, { id: "a" }, { id: "b" }],
    exchanges: [{ code: "NMS" }, { code: "GER" }, { code: "LSE" }],
  });
  assertEquals(
    (await selectAll<{ id: string }>(sb.client, "securities", "id")).map((r) => r.id),
    ["a", "b", "c"],
  );
  assertEquals(
    (await fetchByIds<{ id: string }>(sb.client, "securities", "id", "id", ["c", "b", "a"])).map(
      (r) => r.id,
    ),
    ["a", "b", "c"],
  );
  assertEquals([...(await loadExchanges(sb.client)).keys()], ["GER", "LSE", "NMS"]);
});

Deno.test("every paged read in worker-tick orders before it ranges", async () => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name !== "testing") await walk(path);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(path);
    }
  };
  await walk(
    new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/lib\/$/, ""),
  );
  const bad: string[] = [];
  for (const f of files) {
    const text = await Deno.readTextFile(f);
    for (const m of text.matchAll(/\.range\(/g)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      if (!before.includes(".order(") && !before.includes("orderByPk("))
        bad.push(`${f}@${m.index}`);
    }
  }
  assertEquals(bad, []);
});

Deno.test("paged reads of tables without an `id` column order by their real primary key", async () => {
  const { createFakeSb } = await import("../testing/fake-sb.ts");
  const { fetchByIds, selectAll } = await import("./data.ts");
  const sb = createFakeSb({
    price_series: [{ security_id: "b" }, { security_id: "a" }],
    app_settings: [{ key: "y" }, { key: "x" }],
    risk_monitor_state: [
      { user_id: "u", security_id: "s2" },
      { user_id: "u", security_id: "s1" },
    ],
  });
  const ids = (rows: Array<{ security_id: string }>) => rows.map((r) => r.security_id);
  assertEquals(
    ids(await fetchByIds(sb.client, "price_series", "security_id", "security_id", ["a", "b"])),
    ["a", "b"],
  );
  assertEquals(
    (await selectAll<{ key: string }>(sb.client, "app_settings", "key")).map((r) => r.key),
    ["x", "y"],
  );
  assertEquals(ids(await selectAll(sb.client, "risk_monitor_state", "user_id, security_id")), [
    "s1",
    "s2",
  ]);
});

// ------------------------------------------------------------------------------------------------ research coverage (on-demand research)

Deno.test("computeCoverage: 5 cards and no seeded research report required 0, pending 0, cards 5", () => {
  const c = computeCoverage(base({ research: { required: 0, cards: 5 } }));
  assertEquals([c.research.required, c.research.pending, c.research.cards], [0, 0, 5]);
});

Deno.test("seededResearchJobs: sums the stage_seeded research events, ignoring other stages and bad data", () => {
  assertEquals(seededResearchJobs([]), 0);
  assertEquals(
    seededResearchJobs([
      { data: { stage: "research", jobs: 2 } },
      { data: { stage: "compute", jobs: 40 } },
      { data: { stage: "research", jobs: "x" } },
      { data: null },
    ]),
    2,
  );
});

Deno.test("computeCoverage: two resumed deferred reports are required 2, pending 2, cards unchanged", () => {
  const c = computeCoverage(
    base({
      research: {
        required: seededResearchJobs([{ data: { stage: "research", jobs: 2 } }]),
        cards: 5,
      },
    }),
  );
  assertEquals([c.research.required, c.research.pending, c.research.cards], [2, 2, 5]);
});
