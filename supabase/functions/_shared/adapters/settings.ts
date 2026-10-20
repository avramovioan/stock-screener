import { DEFAULT_SETTINGS, type IndicatorSettings, validateSettings } from "../core/indicator.ts";

/** app_settings keys read by the pipeline: `indicator`, `universe`, `pipeline` (6.3, 7.4). Missing keys fall back to the defaults. */

export interface UniverseSettings {
  thresholdUsd: number; // 50e9, inclusive
  safetyMargin: number; // 0.7: local screener threshold = thresholdUsd * safetyMargin / strongest currency
  minHistoryYears: number; // 10
}
export interface PipelineSettings {
  stageCaps: Record<string, number>; // concurrent leased jobs per stage (7.4)
  batch: {
    fetchBars: number;
    compute: number;
    quoteBatch: number;
    profile: number;
    volumeProbe: number;
  };
  maxStoredBars: number; // 3,300 (A-08)
  leaseSeconds: number; // 180
  claimLimit: number; // jobs claimed per loop iteration
  /**
   * Heavy jobs (fetch_bars, compute, rank_signals) one worker invocation may start before it stops claiming (CPU guard, Free tier 2 s CPU).
   * Default 2. Sizing: largest expected universe about 1,000 securities (spec 7.4 sizing: about 600 plus holdings) -> 84 fetch_bars jobs
   * (12 each) + 40 compute jobs (25 each) + 1 rank = 125 heavy jobs. fetch_bars is capped at 1 concurrent job and cron fires every minute, so
   * the throughput is about `cap` heavy jobs per minute: 125 / 2 = about 63 minutes, far inside the 3 h between the 10:00 Sofia start and
   * the 13:00 Sofia digest cutoff (10:00/11:00 UTC), and 2 x 0.7-1 s CPU stays within the 2 s limit.
   */
  maxHeavyJobsPerInvocation: number;
  stopClaimingMs: number; // 85,000
  hardDeadlineMs: number; // 120,000
  listPublishMinCoverage: number; // 0.95 (A-15)
  carryForwardMaxScans: number; // 3 (A-02)
  maxScreenerPagesPerJob: number; // 10
  yahoo: { minSpacingMs: number; jitterMs: number };
}
export interface AppSettings {
  indicator: IndicatorSettings;
  universe: UniverseSettings;
  pipeline: PipelineSettings;
}

export const DEFAULT_UNIVERSE: Readonly<UniverseSettings> = Object.freeze({
  thresholdUsd: 50e9,
  safetyMargin: 0.7,
  minHistoryYears: 10,
});
export const DEFAULT_PIPELINE: Readonly<PipelineSettings> = Object.freeze({
  stageCaps: Object.freeze({
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
  }) as Record<string, number>,
  batch: Object.freeze({
    fetchBars: 12,
    compute: 25,
    quoteBatch: 500,
    profile: 25,
    volumeProbe: 12,
  }),
  maxStoredBars: 3300,
  leaseSeconds: 180,
  claimLimit: 3,
  maxHeavyJobsPerInvocation: 2,
  stopClaimingMs: 85_000,
  hardDeadlineMs: 120_000,
  listPublishMinCoverage: 0.95,
  carryForwardMaxScans: 3,
  maxScreenerPagesPerJob: 10,
  yahoo: Object.freeze({ minSpacingMs: 340, jitterMs: 100 }),
});

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** A finite number within (min, max]; anything else keeps the default and records a warning. */
function pick(
  src: Rec | undefined,
  key: string,
  fallback: number,
  warnings: string[],
  where: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (src === undefined || src[key] === undefined) return fallback;
  const v = src[key];
  const okType = typeof v === "number" && Number.isFinite(v);
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (
    !okType ||
    (v as number) <= min ||
    (v as number) > max ||
    (opts.integer === true && !Number.isInteger(v))
  ) {
    warnings.push(`${where}.${key} invalid, default ${fallback} kept`);
    return fallback;
  }
  return v as number;
}

/**
 * Worker timing (7.5): stop claiming <= 100 s, stop < hard deadline <= 130 s (150 s wall), lease >= hard deadline + 30 s.
 * A violated bound falls back to the defaults of the group with a logged warning.
 */
function pickTiming(
  p: Rec | undefined,
  warnings: string[],
): { leaseSeconds: number; stopClaimingMs: number; hardDeadlineMs: number } {
  let stopClaimingMs = pick(
    p,
    "stop_claiming_ms",
    DEFAULT_PIPELINE.stopClaimingMs,
    warnings,
    "pipeline",
    { integer: true, max: 100_000 },
  );
  let hardDeadlineMs = pick(
    p,
    "hard_deadline_ms",
    DEFAULT_PIPELINE.hardDeadlineMs,
    warnings,
    "pipeline",
    { integer: true, max: 130_000 },
  );
  if (stopClaimingMs >= hardDeadlineMs) {
    warnings.push(
      `pipeline.stop_claiming_ms must be below hard_deadline_ms, defaults ${DEFAULT_PIPELINE.stopClaimingMs}/${DEFAULT_PIPELINE.hardDeadlineMs} kept`,
    );
    stopClaimingMs = DEFAULT_PIPELINE.stopClaimingMs;
    hardDeadlineMs = DEFAULT_PIPELINE.hardDeadlineMs;
  }
  let leaseSeconds = pick(p, "lease_seconds", DEFAULT_PIPELINE.leaseSeconds, warnings, "pipeline", {
    integer: true,
  });
  if (leaseSeconds < hardDeadlineMs / 1000 + 30) {
    warnings.push(
      `pipeline.lease_seconds must be at least hard_deadline_ms/1000 + 30, default ${DEFAULT_PIPELINE.leaseSeconds} kept`,
    );
    leaseSeconds = DEFAULT_PIPELINE.leaseSeconds;
  }
  return { leaseSeconds, stopClaimingMs, hardDeadlineMs };
}

/** Pure: merges app_settings rows over the defaults. An invalid `indicator` row throws (a scan must never run on guessed settings). */
export function mergeSettings(rows: ReadonlyArray<{ key: string; value: unknown }>): {
  settings: AppSettings;
  warnings: string[];
} {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const warnings: string[] = [];

  let indicator: IndicatorSettings = { ...DEFAULT_SETTINGS };
  if (byKey.has("indicator")) {
    const checked = validateSettings(byKey.get("indicator"));
    if (!checked.ok)
      throw new SettingsError(
        `invalid_indicator_settings: ${checked.issues.map((i) => `${i.field}:${i.code}`).join(",")}`,
      );
    indicator = checked.settings;
    for (const w of checked.warnings) warnings.push(`indicator.${w.field}: ${w.code}`);
  }

  const u = isRec(byKey.get("universe")) ? (byKey.get("universe") as Rec) : undefined;
  const universe: UniverseSettings = {
    thresholdUsd: pick(u, "threshold_usd", DEFAULT_UNIVERSE.thresholdUsd, warnings, "universe"),
    safetyMargin: pick(u, "safety_margin", DEFAULT_UNIVERSE.safetyMargin, warnings, "universe", {
      max: 1,
    }),
    minHistoryYears: pick(
      u,
      "min_history_years",
      DEFAULT_UNIVERSE.minHistoryYears,
      warnings,
      "universe",
      { integer: true },
    ),
  };

  const p = isRec(byKey.get("pipeline")) ? (byKey.get("pipeline") as Rec) : undefined;
  const batch = isRec(p?.["batch_sizes"]) ? (p?.["batch_sizes"] as Rec) : undefined;
  const yahoo = isRec(p?.["yahoo"]) ? (p?.["yahoo"] as Rec) : undefined;
  const caps = isRec(p?.["stage_caps"]) ? (p?.["stage_caps"] as Rec) : undefined;
  const stageCaps: Record<string, number> = { ...DEFAULT_PIPELINE.stageCaps };
  for (const stage of Object.keys(stageCaps))
    stageCaps[stage] = pick(
      caps,
      stage,
      stageCaps[stage] as number,
      warnings,
      "pipeline.stage_caps",
      { integer: true },
    );

  const timing = pickTiming(p, warnings);
  const pipeline: PipelineSettings = {
    stageCaps,
    batch: {
      fetchBars: pick(
        batch,
        "fetch_bars",
        DEFAULT_PIPELINE.batch.fetchBars,
        warnings,
        "pipeline.batch_sizes",
        { integer: true, max: 50 },
      ),
      compute: pick(
        batch,
        "compute",
        DEFAULT_PIPELINE.batch.compute,
        warnings,
        "pipeline.batch_sizes",
        { integer: true, max: 100 },
      ),
      quoteBatch: pick(
        batch,
        "quote_batch",
        DEFAULT_PIPELINE.batch.quoteBatch,
        warnings,
        "pipeline.batch_sizes",
        { integer: true, max: 500 },
      ),
      profile: pick(
        batch,
        "profile",
        DEFAULT_PIPELINE.batch.profile,
        warnings,
        "pipeline.batch_sizes",
        { integer: true, max: 100 },
      ),
      volumeProbe: pick(
        batch,
        "volume_probe",
        DEFAULT_PIPELINE.batch.volumeProbe,
        warnings,
        "pipeline.batch_sizes",
        { integer: true, max: 50 },
      ),
    },
    maxStoredBars: pick(
      p,
      "max_stored_bars",
      DEFAULT_PIPELINE.maxStoredBars,
      warnings,
      "pipeline",
      { integer: true, min: 100 },
    ),
    claimLimit: pick(p, "claim_limit", DEFAULT_PIPELINE.claimLimit, warnings, "pipeline", {
      integer: true,
      max: 10,
    }),
    maxHeavyJobsPerInvocation: pick(
      p,
      "max_heavy_jobs_per_invocation",
      DEFAULT_PIPELINE.maxHeavyJobsPerInvocation,
      warnings,
      "pipeline",
      { integer: true, max: 20 },
    ),
    ...timing,
    listPublishMinCoverage: pick(
      p,
      "list_publish_min_coverage",
      DEFAULT_PIPELINE.listPublishMinCoverage,
      warnings,
      "pipeline",
      { max: 1 },
    ),
    carryForwardMaxScans: pick(
      p,
      "carry_forward_max_scans",
      DEFAULT_PIPELINE.carryForwardMaxScans,
      warnings,
      "pipeline",
      { integer: true },
    ),
    maxScreenerPagesPerJob: pick(
      p,
      "max_screener_pages_per_job",
      DEFAULT_PIPELINE.maxScreenerPagesPerJob,
      warnings,
      "pipeline",
      { integer: true },
    ),
    yahoo: {
      minSpacingMs: pick(
        yahoo,
        "min_spacing_ms",
        DEFAULT_PIPELINE.yahoo.minSpacingMs,
        warnings,
        "pipeline.yahoo",
        { min: 339 },
      ), // never faster than 3 req/s
      jitterMs: pick(
        yahoo,
        "jitter_ms",
        DEFAULT_PIPELINE.yahoo.jitterMs,
        warnings,
        "pipeline.yahoo",
        { integer: true },
      ),
    },
  };
  return { settings: { indicator, universe, pipeline }, warnings };
}

export interface SettingsSource {
  fetchRows(): Promise<ReadonlyArray<{ key: string; value: unknown }>>;
}

export async function loadSettings(
  source: SettingsSource,
): Promise<{ settings: AppSettings; warnings: string[] }> {
  return mergeSettings(await source.fetchRows());
}

export interface ProviderSettings {
  yahooEnabled: boolean;
}

/** Anything but an explicit `false` keeps Yahoo on: a malformed row must never freeze the site. */
export function parseProviderSettings(raw: unknown): ProviderSettings {
  const flag =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).yahoo_enabled
      : undefined;
  return { yahooEnabled: flag !== false };
}

/** Cached read of the kill switch (30 s); a failing read keeps the last known value (default: enabled). */
export function createYahooEnabledCheck(
  read: () => Promise<unknown>,
  nowMs: () => number,
  ttlMs = 30_000,
): () => Promise<boolean> {
  let cached: { at: number; value: boolean } | null = null;
  return async () => {
    const now = nowMs();
    if (cached !== null && now - cached.at < ttlMs) return cached.value;
    let value = cached?.value ?? true;
    try {
      value = parseProviderSettings(await read()).yahooEnabled;
    } catch {
      // keep the last known value
    }
    cached = { at: now, value };
    return value;
  };
}
