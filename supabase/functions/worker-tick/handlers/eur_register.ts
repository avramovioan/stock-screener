import type { SupabaseClient } from "@supabase/supabase-js";
import { systemClock } from "../../_shared/adapters/clock.ts";
import { loadEurFixtures } from "../../_shared/adapters/fixture-eur.ts";
import {
  type CatalogueFetch,
  createFixtureCatalogueFetch,
} from "../../_shared/adapters/ibkr-catalogue.ts";
import type { JobStage } from "../../_shared/adapters/log.ts";
import type { Handler, Seeder } from "../types.ts";
import { runEurCatalogue, seedEurCatalogue } from "./eur_catalogue.ts";
import { runEurResolve, seedEurResolve } from "./eur_resolve.ts";
import { createEurStore } from "./eur_store.ts";

/**
 * Registration of the two EUR stages. `worker-tick/stages.ts` references these four exports in HANDLERS and SEEDERS and lists both stages
 * in PIPELINE_ORDER. Fixture mode (local stack only) answers the catalogue endpoint from fixtures/integration/eur-fixtures.json so the
 * integration test never touches IBKR; live mode uses the global fetch.
 */

async function catalogueFetch(providerMode: "live" | "fixture"): Promise<CatalogueFetch> {
  if (providerMode === "fixture") {
    if (Deno.env.get("ALLOW_FIXTURE_PROVIDERS") !== "1")
      throw new Error("fixture providers are not allowed in this environment");
    return createFixtureCatalogueFetch((await loadEurFixtures()).catalogue);
  }
  return (url, init) => fetch(url, init);
}

export const handleEurCatalogue: Handler = async (ctx) =>
  runEurCatalogue(ctx, {
    store: createEurStore(ctx.db.sb as SupabaseClient),
    fetchImpl: await catalogueFetch(ctx.run.providerMode),
    clock: systemClock,
  });

export const handleEurResolve: Handler = (ctx) =>
  runEurResolve(ctx, {
    store: createEurStore(ctx.db.sb as SupabaseClient),
    market: ctx.providers.market,
  });

export const seedEurCatalogueStage: Seeder = (ctx) => Promise.resolve(seedEurCatalogue(ctx));

export const seedEurResolveStage: Seeder = (ctx) =>
  seedEurResolve(ctx, createEurStore(ctx.db.sb as SupabaseClient));

/**
 * Merges the two EUR stages into the registries of a worker invocation (one call in `worker-tick/index.ts`, like `withDigest`).
 * The database order lives in `app.next_stage_to_seed` (eur_catalogue after identity, eur_resolve after news); the claim list order is irrelevant.
 */
export function withEur<
  T extends {
    stages: readonly JobStage[];
    handlers: Partial<Record<JobStage, Handler>>;
    seeders: Partial<Record<JobStage, Seeder>>;
  },
>(base: T) {
  const add = ["eur_catalogue", "eur_resolve"] as const;
  return {
    stages: [...base.stages, ...add.filter((s) => !base.stages.includes(s))],
    handlers: {
      ...base.handlers,
      eur_catalogue: handleEurCatalogue,
      eur_resolve: handleEurResolve,
    },
    seeders: {
      ...base.seeders,
      eur_catalogue: seedEurCatalogueStage,
      eur_resolve: seedEurResolveStage,
    },
  };
}
