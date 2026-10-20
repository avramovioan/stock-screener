import { systemClock } from "../_shared/adapters/clock.ts";
import { createQuoteCacheKv, type Db } from "../_shared/adapters/db.ts";
import {
  createFixtureProviders,
  loadWorld,
  type World,
} from "../_shared/adapters/fixture-providers.ts";
import { createFxProvider } from "../_shared/adapters/fx.ts";
import { createYahooEnabledCheck } from "../_shared/adapters/settings.ts";
import { createYahooProvider } from "../_shared/adapters/yahoo.ts";
import { FatalJobError, type Providers, type RunInfo } from "./types.ts";

/** Providers for one run. Fixture mode needs ALLOW_FIXTURE_PROVIDERS=1, which only the local function environment sets (7.12). */
export function createProviders(a: {
  run: RunInfo;
  db: Db;
  onEvent: (event: string, data: Record<string, unknown>) => void;
  world?: World;
}): Providers {
  if (a.run.providerMode === "fixture") {
    if (Deno.env.get("ALLOW_FIXTURE_PROVIDERS") !== "1")
      throw new FatalJobError("fixture_providers_not_allowed");
    if (a.world === undefined) throw new FatalJobError("fixture_world_not_loaded");
    return createFixtureProviders(a.world, a.run.fixtureSet ?? "day1");
  }
  const market = createYahooProvider({
    fetchImpl: fetch,
    store: createQuoteCacheKv(a.db.sb),
    clock: systemClock,
    rate: a.run.settings.pipeline.yahoo,
    onEvent: a.onEvent,
    isEnabled: createYahooEnabledCheck(
      async () =>
        (await a.db.sb.from("app_settings").select("value").eq("key", "providers").maybeSingle())
          .data?.value,
      Date.now,
    ),
  });
  const fx = createFxProvider({
    fetchImpl: fetch,
    clock: systemClock,
    quote: (symbols) => market.quote(symbols),
    onEvent: a.onEvent,
  });
  return { market, fx };
}

export { loadWorld };
