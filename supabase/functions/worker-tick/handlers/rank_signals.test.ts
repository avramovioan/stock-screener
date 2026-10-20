import { assert, assertEquals, assertRejects } from "@std/assert";
import { RUN_ID, testCtx } from "../testing/ctx.ts";
import {
  createFakeSb,
  type FakeSb,
  type Row,
  registerTransitionEpisode,
} from "../testing/fake-sb.ts";
import { handleRankSignals } from "./rank_signals.ts";

const END = { base: 100, upper1: 110, upper2: 120, lower1: 90, lower2: 80 };
const channel = { end: END, rising: true };

/**
 * Twelve German primary listings s1..s11 (+ s12) with falling market caps, so s11 is rank 11. s11 holds an active LEGACY episode on the
 * -4 line (opened before A-51, when rank 11+ triggered on -4) and closes at 70, below both lines (-3 = 90, -4 = 80): the episode is
 * continued silently on the -3 line. s12 fell below US$50B (own snapshot,
 * no result row) and "oldA" is a former canonical listing of company c3, which s3 now represents.
 */
function world(): FakeSb {
  const n = 11;
  const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
  const cap = (i: number) => (200 - i) * 1e9;
  const fake = createFakeSb({
    scan_runs: [
      { id: "run-prev", scan_date_local: "2026-10-14", list_published_at: "2026-10-14T08:00:00Z" },
      { id: RUN_ID, scan_date_local: "2026-10-15", list_published_at: null },
    ],
    exchanges: [
      {
        code: "GER",
        country: "Germany",
        venue_class: "primary",
        currencies: ["EUR"],
        screener_enabled: true,
        trading_days: [1, 2, 3, 4, 5],
        session_close_local: "17:30:00",
        max_gap_days: 5,
        us_primary: false,
        timezone: "Europe/Berlin",
      },
    ],
    companies: [...ids, "s12"].map((id) => ({ id: `c-${id}`, country: "Germany" })),
    securities: [
      ...[...ids, "s12"].map((id) => ({
        id,
        company_id: `c-${id}`,
        yahoo_symbol: id.toUpperCase(),
        exchange_code: "GER",
        currency: "EUR",
        currency_major: "EUR",
        financial_currency: "EUR",
        avg_usd_volume_30d: 1e6,
        is_canonical: true,
        status: "active",
        quote_type: "EQUITY",
      })),
      {
        id: "oldA",
        company_id: "c-s3",
        yahoo_symbol: "OLDA",
        exchange_code: "GER",
        currency: "EUR",
        currency_major: "EUR",
        financial_currency: "EUR",
        avg_usd_volume_30d: 1e6,
        is_canonical: false,
        status: "active",
        quote_type: "EQUITY",
      },
    ],
    security_identity_overrides: [],
    scan_security_results: ids.map((id, i) => ({
      scan_run_id: RUN_ID,
      security_id: id,
      status: "processed",
      reason_codes: [],
      session_date: "2026-10-14",
      close: id === "s11" ? 70 : 200,
      freshness: "fresh",
      channel,
      market_cap_usd: cap(i),
      tier1_member: true,
    })),
    market_cap_snapshots: [
      ...ids.map((id, i) => ({
        scan_run_id: RUN_ID,
        security_id: id,
        market_cap_usd: cap(i),
        market_cap_native: cap(i),
        currency_major: "EUR",
      })),
      {
        scan_run_id: RUN_ID,
        security_id: "s12",
        market_cap_usd: 30e9,
        market_cap_native: 30e9,
        currency_major: "EUR",
      },
    ],
    universe_snapshots: [
      ...ids.map((id, i) => ({
        scan_run_id: "run-prev",
        mode: "worldwide",
        security_id: id,
        company_id: `c-${id}`,
        rank: i + 1,
        market_cap_usd: cap(i),
        state: "member",
        applicable_line: i + 1 <= 10 ? "-3" : "-4",
      })),
      {
        scan_run_id: "run-prev",
        mode: "worldwide",
        security_id: "s12",
        company_id: "c-s12",
        rank: 12,
        market_cap_usd: 55e9,
        state: "member",
        applicable_line: "-4",
      },
      {
        scan_run_id: "run-prev",
        mode: "worldwide",
        security_id: "oldA",
        company_id: "c-s3",
        rank: 13,
        market_cap_usd: 150e9,
        state: "member",
        applicable_line: "-4",
      },
    ],
    scan_security_results_prev: [],
    signal_episodes: [
      {
        id: "e0",
        security_id: "s11",
        company_id: "c-s11",
        kind: "discount",
        mode: "worldwide",
        threshold_line: "-4",
        status: "active",
        opened_scan_run_id: "run-prev",
        opened_session_date: "2026-10-10",
        last_evaluated_session_date: "2026-10-13",
        rank_history: [{ rank: 11 }],
      },
    ],
    todays_discounts: [],
    universe_membership_events: [],
    scan_jobs: [],
  });
  // yesterday's results of s12 (no row today): needed only for the reason lookup, which reads scan_security_results of run-prev
  fake.tables["scan_security_results"]?.push({
    scan_run_id: "run-prev",
    security_id: "s12",
    reason_codes: [],
  });
  fake.unique["universe_snapshots"] = [["scan_run_id", "mode", "security_id"]];
  registerTransitionEpisode(fake);
  return fake;
}

const episodes = (sb: FakeSb) => sb.tables["signal_episodes"] ?? [];

Deno.test("a failed close+continuation leaves the episode untouched; the retry opens exactly one silent continuation", async () => {
  const sb = world();
  const real = sb.rpcs["transition_episode"] as NonNullable<FakeSb["rpcs"][string]>;
  let calls = 0;
  sb.rpcs["transition_episode"] = (a) => (calls++ === 0 ? { error: { message: "boom" } } : real(a));

  await assertRejects(() => handleRankSignals(testCtx(sb)), Error, "transition_episode");
  assertEquals(episodes(sb).length, 1, "no second episode after the failed attempt");
  assertEquals(
    episodes(sb)[0]?.["status"],
    "active",
    "the old episode is still active (the close was rolled back with the insert)",
  );

  await handleRankSignals(testCtx(sb));
  assertEquals(episodes(sb).length, 2);
  const old = episodes(sb).find((e) => e["id"] === "e0");
  assertEquals([old?.["status"], old?.["close_reason"]], ["closed", "threshold_changed"]);
  const next = episodes(sb).find((e) => e["continues_episode_id"] === "e0");
  assertEquals(
    [next?.["threshold_line"], next?.["notify"], next?.["open_reason"], next?.["status"]],
    ["-3", false, "continuation", "active"],
  );
  assert(
    episodes(sb).every((e) => e["notify"] !== true),
    "no notifying episode is ever opened by the retry",
  );

  // a further run of the same session changes nothing
  await handleRankSignals(testCtx(sb));
  assertEquals(episodes(sb).length, 2);
});

Deno.test("a previous member below the threshold is removed for that reason, and a former canonical listing is not carried next to its successor", async () => {
  const sb = world();
  const out = await handleRankSignals(testCtx(sb));
  const today = (sb.tables["universe_snapshots"] ?? []).filter(
    (r) => r["scan_run_id"] === RUN_ID && r["mode"] === "worldwide",
  );
  assertEquals(
    today.map((r) => r["security_id"]).sort(),
    Array.from({ length: 11 }, (_, i) => `s${i + 1}`).sort(),
    "neither s12 nor oldA is carried",
  );
  assert(today.every((r) => r["state"] === "member"));
  assertEquals(out["carried"], 0);
  const events = (sb.tables["universe_membership_events"] ?? []).map(
    (e) => `${e["event"]}:${e["security_id"]}:${e["reason"]}`,
  );
  assertEquals(events, ["removed:s12:market_cap_below_threshold"]);
});

// ---------------------------------------------------------------------------------------------------- stale episodes (final fix wave A)

/**
 * Assumption (the spec is silent on episodes of securities that leave the candidate set): an active discount episode whose security has no
 * result row in this scan and in the two completed scans before it is closed with reason `left_universe`.
 */
function worldWithGone(): FakeSb {
  const sb = world();
  const runs = sb.tables["scan_runs"] as Row[];
  Object.assign(runs.find((r) => r["id"] === "run-prev") as Row, { status: "complete" });
  runs.push({
    id: "run-p2",
    scan_date_local: "2026-10-13",
    status: "complete",
    list_published_at: "2026-10-13T08:00:00Z",
  });
  (sb.tables["securities"] as Row[]).push({
    id: "gone",
    company_id: "c-gone",
    yahoo_symbol: "GONE",
    exchange_code: "GER",
    currency: "EUR",
    currency_major: "EUR",
    financial_currency: "EUR",
    avg_usd_volume_30d: 1e6,
    is_canonical: true,
    status: "active",
    quote_type: "EQUITY",
  });
  (sb.tables["signal_episodes"] as Row[]).push({
    id: "e-gone",
    security_id: "gone",
    company_id: "c-gone",
    kind: "discount",
    mode: "worldwide",
    threshold_line: "-3",
    status: "active",
    opened_scan_run_id: "run-p2",
    opened_session_date: "2026-10-01",
    last_evaluated_session_date: "2026-10-09",
    rank_history: [{ rank: 5 }],
  });
  return sb;
}

Deno.test("an active episode whose security has no result row for 3 consecutive completed scans is closed as left_universe", async () => {
  const sb = worldWithGone();
  await handleRankSignals(testCtx(sb));
  const e = episodes(sb).find((x) => x["id"] === "e-gone");
  assertEquals(
    [e?.["status"], e?.["close_reason"], e?.["closed_scan_run_id"], e?.["closed_session_date"]],
    ["closed", "left_universe", RUN_ID, "2026-10-09"],
  );
  // idempotent: a rerun of the stage changes nothing
  await handleRankSignals(testCtx(sb));
  assertEquals(episodes(sb).filter((x) => x["id"] === "e-gone").length, 1);
});

Deno.test("a result row in one of the two previous completed scans keeps the episode active", async () => {
  const sb = worldWithGone();
  (sb.tables["scan_security_results"] as Row[]).push({
    scan_run_id: "run-p2",
    security_id: "gone",
    reason_codes: [],
  });
  await handleRankSignals(testCtx(sb));
  assertEquals(episodes(sb).find((x) => x["id"] === "e-gone")?.["status"], "active");
});

Deno.test("fewer than two completed earlier scans never close an episode", async () => {
  const sb = worldWithGone();
  (sb.tables["scan_runs"] as Row[]).splice(
    (sb.tables["scan_runs"] as Row[]).findIndex((r) => r["id"] === "run-p2"),
    1,
  );
  await handleRankSignals(testCtx(sb));
  assertEquals(episodes(sb).find((x) => x["id"] === "e-gone")?.["status"], "active");
});

// ---------------------------------------------------------------------------------------------------- A-51: every rank triggers on -3

/** world() without the legacy episode, s11 (rank 11) closing at 85: between its -4 line (80) and its -3 line (90). */
function worldBetweenLines(): FakeSb {
  const sb = world();
  sb.tables["signal_episodes"] = [];
  const r = (sb.tables["scan_security_results"] as Row[]).find((x) => x["security_id"] === "s11");
  Object.assign(r as Row, { close: 85 });
  return sb;
}

Deno.test("a rank 11 security between its -4 and -3 lines opens a notifying episode on the -3 line (rank never moves the trigger)", async () => {
  const sb = worldBetweenLines();
  await handleRankSignals(testCtx(sb));
  assertEquals(
    episodes(sb).map((e) => [e["security_id"], e["threshold_line"], e["notify"], e["open_reason"]]),
    [["s11", "-3", true, "new_entry"]],
  );
});

Deno.test("the snapshot of a rank 11 security says -3, keeps the -3 end and flags the discount; the card carries the -3 line", async () => {
  const sb = worldBetweenLines();
  await handleRankSignals(testCtx(sb));
  const snap = (sb.tables["universe_snapshots"] ?? []).find(
    (r) => r["scan_run_id"] === RUN_ID && r["mode"] === "worldwide" && r["security_id"] === "s11",
  );
  assertEquals(
    [
      snap?.["rank"],
      snap?.["is_top10"],
      snap?.["applicable_line"],
      snap?.["lower_line_end"],
      snap?.["is_discount"],
    ],
    [11, false, "-3", 90, true],
  );
  const cards = sb.tables["todays_discounts"] ?? [];
  assertEquals(
    cards.map((c) => [c["security_id"], c["rank"], c["threshold_line"], c["lower_line_end"]]),
    [["s11", 11, "-3", 90]],
  );
  const ch = cards[0]?.["channel"] as { end: { lower1: number; lower2: number } };
  assertEquals(
    [ch.end.lower1, ch.end.lower2],
    [90, 80],
    "both line values stay on the card for the feed to derive line4_end",
  );
});

Deno.test("a top 10 security and a rank 11 security at the same depth both become cards", async () => {
  const sb = worldBetweenLines();
  const r = (sb.tables["scan_security_results"] as Row[]).find((x) => x["security_id"] === "s4");
  Object.assign(r as Row, { close: 85 });
  await handleRankSignals(testCtx(sb));
  assertEquals(
    (sb.tables["todays_discounts"] ?? [])
      .map((c) => [c["security_id"], c["threshold_line"]])
      .sort(),
    [
      ["s11", "-3"],
      ["s4", "-3"],
    ],
  );
});

Deno.test("a close above the -3 line is not a discount for any rank (the old -4 depth is irrelevant)", async () => {
  const sb = worldBetweenLines();
  const r = (sb.tables["scan_security_results"] as Row[]).find((x) => x["security_id"] === "s11");
  Object.assign(r as Row, { close: 95 });
  await handleRankSignals(testCtx(sb));
  assertEquals(episodes(sb).length, 0);
  assertEquals((sb.tables["todays_discounts"] ?? []).length, 0);
});
