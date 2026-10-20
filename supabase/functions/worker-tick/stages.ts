import type { JobStage } from "../_shared/adapters/log.ts";
import { handleClassify, seedClassify } from "./handlers/classify.ts";
import { handleCompute, seedCompute } from "./handlers/compute.ts";
import { handleFetchBars, seedFetchBars } from "./handlers/fetch_bars.ts";
import { handleFx, seedFx } from "./handlers/fx.ts";
import { handleIdentity, seedIdentity } from "./handlers/identity.ts";
import { handlePortfolioScan, seedPortfolioScan } from "./handlers/portfolio_scan.ts";
import { handlePublish, seedPublish } from "./handlers/publish.ts";
import { handleRankSignals, seedRankSignals } from "./handlers/rank_signals.ts";
import { handleUniverseSweep, seedUniverseSweep } from "./handlers/universe_sweep.ts";
import type { Handler, Seeder } from "./types.ts";

/** Pipeline order of P1 (7.4 stages 1-7). Mirrors app.next_stage_to_seed; later phases insert research, news, digest, ... */
export const PIPELINE_ORDER: JobStage[] = [
  "fx",
  "universe_sweep",
  "identity",
  "fetch_bars",
  "compute",
  "rank_signals",
  "classify",
  "publish",
  "portfolio_scan", // P5b stage 8: holdings bars, valuation tags, premium episodes, risk set (app.next_stage_to_seed slot after publish:initial)
];

export const HANDLERS: Partial<Record<JobStage, Handler>> = {
  fx: handleFx,
  universe_sweep: handleUniverseSweep,
  identity: handleIdentity,
  fetch_bars: handleFetchBars,
  compute: handleCompute,
  rank_signals: handleRankSignals,
  classify: handleClassify,
  publish: handlePublish,
  portfolio_scan: handlePortfolioScan,
};

export const SEEDERS: Partial<Record<JobStage, Seeder>> = {
  fx: seedFx,
  universe_sweep: seedUniverseSweep,
  identity: seedIdentity,
  fetch_bars: seedFetchBars,
  compute: seedCompute,
  rank_signals: seedRankSignals,
  classify: seedClassify,
  publish: seedPublish,
  portfolio_scan: seedPortfolioScan,
};
