import { assertEquals } from "@std/assert";
import {
  applyPremiumEpisodes,
  buildHoldingRows,
  type HoldingResult,
  type PremiumStore,
  planPortfolioJobs,
  tagFor,
} from "./portfolio_scan.ts";

const END = { upper2: 140, upper1: 120, base: 100, lower1: 85, lower2: 70 };
const result = (o: Partial<HoldingResult> = {}): HoldingResult => ({
  securityId: "s1",
  status: "processed",
  sessionDate: "2026-10-14",
  close: 100,
  channel: { end: END },
  quoteType: "EQUITY",
  companyId: "co1",
  ...o,
});

Deno.test("planPortfolioJobs seeds holdings chunks of 12 plus premium and risk_set, always (an empty portfolio still ends the stage)", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const plan = planPortfolioJobs(ids);
  assertEquals(plan.keys, ["holdings:0", "holdings:1", "holdings:2", "premium", "risk_set"]);
  assertEquals(((plan.payloads ?? [])[2] as { securityIds: string[] }).securityIds.length, 1);
  assertEquals(plan.priorities, [10, 10, 10, 20, 30]);
  assertEquals(planPortfolioJobs([]).keys, ["premium", "risk_set"]);
});

Deno.test("tag mapping: Discounted at or below the -3 line, Premium at +1, Extra premium at +2, none in between, Unavailable without a channel", () => {
  assertEquals(tagFor(result({ close: 85 }), null).tag, "discounted");
  assertEquals(tagFor(result({ close: 84.99 }), null).tag, "discounted");
  assertEquals(tagFor(result({ close: 85.01 }), null).tag, "none");
  assertEquals(tagFor(result({ close: 120 }), null).tag, "premium");
  assertEquals(tagFor(result({ close: 140 }), null).tag, "extra_premium");
  assertEquals(tagFor(result({ close: 100 }), null).tag, "none");
  assertEquals(tagFor(result({ channel: null }), null).tag, "unavailable");
  assertEquals(tagFor(result({ status: "insufficient_data" }), null).tag, "unavailable");
  assertEquals(tagFor(result({ status: "stale" }), null).tag, "unavailable");
  assertEquals(tagFor(result({ quoteType: "ETF", close: 50 }), null).tag, "unavailable");
  assertEquals(tagFor(undefined, null), {
    tag: "unavailable",
    reason: "no scan result for this security",
    sessionDate: null,
  });
});

Deno.test("every holding uses the -3 line whatever its rank, and a zero or negative lower line is never a discount", () => {
  assertEquals(tagFor(result({ close: 80 }), null).tag, "discounted"); // -3 line is 85
  assertEquals(tagFor(result({ close: 80 }), 11).tag, "discounted");
  assertEquals(tagFor(result({ close: 80 }), 7).tag, "discounted");
  assertEquals(tagFor(result({ close: 90 }), 40).tag, "none");
  assertEquals(
    tagFor(result({ close: 0, channel: { end: { ...END, lower1: 0 } } }), null).tag,
    "none",
  ); // close <= 0 line, but the zero-line rule blocks it
});

Deno.test("the tag explains its basis with the session date of the completed close, never the delayed quote", () => {
  const t = tagFor(result({ close: 70 }), null);
  assertEquals(t.sessionDate, "2026-10-14");
  assertEquals(t.reason, "based on close of 2026-10-14");
});

Deno.test("buildHoldingRows writes holding_only results with the channel, freshness status and validity", () => {
  const rows = buildHoldingRows({
    runId: "r1",
    length: 2500,
    nowIso: "2026-10-15T08:00:00.000Z",
    securities: [
      { id: "s1", quote_type: "EQUITY", exchange_code: "NMS" },
      { id: "s2", quote_type: "EQUITY", exchange_code: "NMS" },
      { id: "s3", quote_type: "EQUITY", exchange_code: "NMS" },
    ],
    series: [
      {
        security_id: "s1",
        close: [1, 2, 3],
        bar_count: 2600,
        last_session_date: "2026-10-14",
        completeness: {},
        end: END,
      },
      {
        security_id: "s2",
        close: [1, 2, 3],
        bar_count: 100,
        last_session_date: "2026-10-14",
        completeness: {},
        end: null,
      },
    ],
    freshness: () => "fresh",
  });
  assertEquals(
    rows.map((r) => [r["security_id"], r["status"], r["scope"]]),
    [
      ["s1", "processed", "holding_only"],
      ["s2", "insufficient_data", "holding_only"],
      ["s3", "failed", "holding_only"],
    ],
  );
  assertEquals(((rows[0] ?? {})["channel"] as { end: typeof END }).end.upper1, 120);
  assertEquals(rows[0]?.["tier1_member"], false);
  assertEquals(rows[2]?.["reason_codes"], ["unprocessed"]);
});

function fakePremiumStore() {
  const episodes: Array<{
    id: string;
    kind: string;
    closed: boolean;
    opened: string;
    last: number;
  }> = [];
  const store: PremiumStore = {
    active: (securityId, kind) => {
      const e = episodes.find((x) => x.kind === kind && !x.closed);
      return Promise.resolve(
        e === undefined
          ? null
          : {
              id: e.id,
              kind: kind,
              mode: "worldwide",
              line: kind === "premium1" ? "+1" : "+2",
              openedSessionDay: 0,
              lastEvaluatedSessionDay: e.last,
            },
      );
    },
    open: (e) => (
      episodes.push({
        id: `e${episodes.length}`,
        kind: e.kind,
        closed: false,
        opened: e.sessionDate,
        last: e.sessionDay,
      }),
      Promise.resolve()
    ),
    close: (id) => {
      const e = episodes.find((x) => x.id === id);
      if (e !== undefined) e.closed = true;
      return Promise.resolve();
    },
    touch: (id, _date, day) => {
      const e = episodes.find((x) => x.id === id);
      if (e !== undefined) e.last = day;
      return Promise.resolve();
    },
  };
  return { store, episodes };
}

const obs = (close: number, sessionDate: string, canOpen = true) => ({
  runId: "r1",
  securityId: "s1",
  companyId: "co1",
  sessionDate,
  close,
  end: { upper1: 120, upper2: 140 },
  canOpen,
});

Deno.test("premium episodes: +1 and +2 are independent, carry mode worldwide, open once, re-arm only below the line", async () => {
  const { store, episodes } = fakePremiumStore();
  assertEquals(await applyPremiumEpisodes(store, obs(125, "2026-10-12")), { opened: 1, closed: 0 }); // +1 only
  assertEquals(await applyPremiumEpisodes(store, obs(125, "2026-10-12")), { opened: 0, closed: 0 }); // same session: idempotent
  assertEquals(await applyPremiumEpisodes(store, obs(150, "2026-10-13")), { opened: 1, closed: 0 }); // +2 opens, +1 continues
  assertEquals(await applyPremiumEpisodes(store, obs(130, "2026-10-14")), { opened: 0, closed: 1 }); // +2 closes, +1 stays
  assertEquals(
    episodes.map((e) => [e.kind, e.closed]),
    [
      ["premium1", false],
      ["premium2", true],
    ],
  );
  assertEquals(await applyPremiumEpisodes(store, obs(110, "2026-10-15")), { opened: 0, closed: 1 }); // +1 closes
  assertEquals(await applyPremiumEpisodes(store, obs(121, "2026-10-16")), { opened: 1, closed: 0 }); // new +1 episode
  assertEquals(episodes.filter((e) => e.kind === "premium1").length, 2);
});

Deno.test("premium episodes need an evaluable held equity but no rising channel, rank or market cap (A-36)", async () => {
  const { store, episodes } = fakePremiumStore();
  assertEquals(await applyPremiumEpisodes(store, obs(125, "2026-10-12", false)), {
    opened: 0,
    closed: 0,
  });
  assertEquals(episodes.length, 0);
});
