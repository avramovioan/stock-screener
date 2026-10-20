import { assertEquals, assertThrows } from "@std/assert";
import { DEFAULT_SETTINGS } from "../core/indicator.ts";
import {
  createYahooEnabledCheck,
  DEFAULT_PIPELINE,
  DEFAULT_UNIVERSE,
  loadSettings,
  mergeSettings,
  parseProviderSettings,
  SettingsError,
} from "./settings.ts";

Deno.test("no rows: every setting is the documented default", () => {
  const { settings, warnings } = mergeSettings([]);
  assertEquals(settings.indicator, DEFAULT_SETTINGS);
  assertEquals(settings.universe, { thresholdUsd: 50e9, safetyMargin: 0.7, minHistoryYears: 10 });
  assertEquals(settings.pipeline.batch, {
    fetchBars: 12,
    compute: 25,
    quoteBatch: 500,
    profile: 25,
    volumeProbe: 12,
  });
  assertEquals(settings.pipeline.stageCaps, {
    fx: 1,
    universe_sweep: 1,
    identity: 1,
    fetch_bars: 1,
    compute: 2,
    rank_signals: 1,
    classify: 1,
    publish: 1,
    news: 1,
    research: 2,
    portfolio_scan: 1,
    eur_catalogue: 1,
    eur_resolve: 1,
  });
  assertEquals(
    [
      settings.pipeline.maxStoredBars,
      settings.pipeline.leaseSeconds,
      settings.pipeline.stopClaimingMs,
      settings.pipeline.hardDeadlineMs,
    ],
    [3300, 180, 85_000, 120_000],
  );
  assertEquals(settings.pipeline.yahoo, { minSpacingMs: 340, jitterMs: 100 });
  assertEquals(warnings, []);
});

Deno.test("valid rows override the defaults (snake_case keys in the table, camelCase in code)", () => {
  const { settings } = mergeSettings([
    { key: "indicator", value: { ...DEFAULT_SETTINGS, length: 2000 } },
    { key: "universe", value: { threshold_usd: 40e9, safety_margin: 0.6, min_history_years: 8 } },
    {
      key: "pipeline",
      value: { batch_sizes: { fetch_bars: 6 }, stage_caps: { compute: 3 }, max_stored_bars: 3000 },
    },
  ]);
  assertEquals(settings.indicator.length, 2000);
  assertEquals(settings.universe, { thresholdUsd: 40e9, safetyMargin: 0.6, minHistoryYears: 8 });
  assertEquals(settings.pipeline.batch.fetchBars, 6);
  assertEquals(settings.pipeline.batch.compute, 25);
  assertEquals(settings.pipeline.stageCaps["compute"], 3);
  assertEquals(settings.pipeline.maxStoredBars, 3000);
});

Deno.test("an invalid universe or pipeline value keeps the default and warns; the pipeline never runs faster than 3 requests per second", () => {
  const { settings, warnings } = mergeSettings([
    { key: "universe", value: { threshold_usd: "lots", safety_margin: 1.5 } },
    {
      key: "pipeline",
      value: { batch_sizes: { fetch_bars: 0, compute: 1000 }, yahoo: { min_spacing_ms: 100 } },
    },
  ]);
  assertEquals(settings.universe.thresholdUsd, DEFAULT_UNIVERSE.thresholdUsd);
  assertEquals(settings.universe.safetyMargin, DEFAULT_UNIVERSE.safetyMargin);
  assertEquals(settings.pipeline.batch.fetchBars, DEFAULT_PIPELINE.batch.fetchBars);
  assertEquals(settings.pipeline.batch.compute, DEFAULT_PIPELINE.batch.compute);
  assertEquals(settings.pipeline.yahoo.minSpacingMs, 340);
  assertEquals(warnings.length, 5);
});

Deno.test("an invalid indicator row throws: a scan never runs on guessed settings", () => {
  assertThrows(
    () => mergeSettings([{ key: "indicator", value: { ...DEFAULT_SETTINGS, length: 2 } }]),
    SettingsError,
    "invalid_indicator_settings",
  );
  assertThrows(() => mergeSettings([{ key: "indicator", value: "nope" }]), SettingsError);
});

Deno.test("indicator warnings (length below 30) are surfaced", () => {
  const { warnings } = mergeSettings([
    { key: "indicator", value: { ...DEFAULT_SETTINGS, length: 10 } },
  ]);
  assertEquals(warnings, ["indicator.length: length_below_30"]);
});

Deno.test("unknown keys and non-object rows are ignored", () => {
  const { settings } = mergeSettings([
    { key: "research", value: { anything: 1 } },
    { key: "universe", value: [1, 2, 3] },
  ]);
  assertEquals(settings.universe, { thresholdUsd: 50e9, safetyMargin: 0.7, minHistoryYears: 10 });
});

Deno.test("loadSettings reads through the source", async () => {
  const { settings } = await loadSettings({
    fetchRows: () => Promise.resolve([{ key: "universe", value: { threshold_usd: 60e9 } }]),
  });
  assertEquals(settings.universe.thresholdUsd, 60e9);
});

Deno.test("providers setting: only an explicit false disables Yahoo", () => {
  assertEquals(parseProviderSettings({ yahoo_enabled: false }).yahooEnabled, false);
  for (const raw of [
    { yahoo_enabled: true },
    {},
    null,
    undefined,
    "x",
    { yahoo_enabled: "false" },
  ]) {
    assertEquals(parseProviderSettings(raw).yahooEnabled, true);
  }
});

Deno.test("createYahooEnabledCheck caches for the ttl and keeps the last value when the read fails", async () => {
  let now = 0;
  let reads = 0;
  let raw: unknown = { yahoo_enabled: true };
  let fail = false;
  const check = createYahooEnabledCheck(
    () => {
      reads++;
      return fail ? Promise.reject(new Error("db")) : Promise.resolve(raw);
    },
    () => now,
    30_000,
  );
  assertEquals(await check(), true);
  assertEquals(reads, 1);
  raw = { yahoo_enabled: false };
  now = 10_000;
  assertEquals(await check(), true);
  assertEquals(reads, 1);
  now = 31_000;
  assertEquals(await check(), false);
  assertEquals(reads, 2);
  fail = true;
  now = 70_000;
  assertEquals(await check(), false);
});

// ---------------------------------------------------------------------------------------------------- final fix wave A

const timing = (p: Record<string, unknown>) => mergeSettings([{ key: "pipeline", value: p }]);

Deno.test("timing bounds: stop_claiming_ms <= 100000, stop < hard_deadline_ms <= 130000, lease_seconds >= hard/1000 + 30", () => {
  for (const bad of [
    { stop_claiming_ms: 100_001 },
    { hard_deadline_ms: 130_001 },
    { hard_deadline_ms: 200_000 },
    { lease_seconds: 100 },
    { stop_claiming_ms: 90_000, hard_deadline_ms: 90_000 },
    { stop_claiming_ms: 95_000, hard_deadline_ms: 90_000 },
    { hard_deadline_ms: 120_000, lease_seconds: 149 },
  ]) {
    const { settings, warnings } = timing(bad);
    assertEquals(
      [
        settings.pipeline.stopClaimingMs,
        settings.pipeline.hardDeadlineMs,
        settings.pipeline.leaseSeconds,
      ],
      [85_000, 120_000, 180],
      `out-of-bounds ${JSON.stringify(bad)} falls back to the defaults`,
    );
    assertEquals(warnings.length > 0, true, `a warning is logged for ${JSON.stringify(bad)}`);
  }
  const ok = timing({ stop_claiming_ms: 100_000, hard_deadline_ms: 130_000, lease_seconds: 160 });
  assertEquals(ok.warnings, []);
  assertEquals(
    [
      ok.settings.pipeline.stopClaimingMs,
      ok.settings.pipeline.hardDeadlineMs,
      ok.settings.pipeline.leaseSeconds,
    ],
    [100_000, 130_000, 160],
  );
});

Deno.test("max_heavy_jobs_per_invocation: default 2, integer 1..20, anything else keeps the default with a warning", () => {
  assertEquals(mergeSettings([]).settings.pipeline.maxHeavyJobsPerInvocation, 2);
  assertEquals(
    timing({ max_heavy_jobs_per_invocation: 5 }).settings.pipeline.maxHeavyJobsPerInvocation,
    5,
  );
  for (const bad of [0, -1, 21, 1.5, "3"]) {
    const r = timing({ max_heavy_jobs_per_invocation: bad });
    assertEquals(r.settings.pipeline.maxHeavyJobsPerInvocation, 2);
    assertEquals(r.warnings.length, 1);
  }
});
