import { createServiceDb, type Db } from "@adapters/db.ts";
import type { World } from "@adapters/fixture-providers.ts";
import { json, requireCronSecret } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";
import { createSupabaseMonitorStore } from "@adapters/monitor_store.ts";
import { createResearchDeps } from "@adapters/research_providers.ts";
import { mergeSettings } from "@adapters/settings.ts";
import { withDigest } from "./handlers/digest.ts";
import { withEur } from "./handlers/eur_register.ts";
import { registerP2, withP2 } from "./handlers/p2_register.ts";
import { activeRunIds, loadRun } from "./lib/data.ts";
import { type LoopSummary, runLoop } from "./loop.ts";
import { createProviders, loadWorld } from "./providers.ts";
import { HANDLERS, PIPELINE_ORDER, SEEDERS } from "./stages.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function runWorker(worker: string, t0: number, db: Db): Promise<LoopSummary> {
  const rows = await db.sb.from("app_settings").select("key, value").in("key", ["pipeline"]);
  const { settings } = mergeSettings(rows.data ?? []);
  let world: World | undefined;
  // P2: research, news and the final classify / publish are merged into the P1 registries once per invocation
  // P3: the digest stage (spec 7.4 stage 12) follows publish:final
  // P6: eur_catalogue (after identity) and eur_resolve (after news) are merged in as well
  const p2 = withEur(
    withDigest(
      withP2(
        { stages: PIPELINE_ORDER, handlers: HANDLERS, seeders: SEEDERS },
        registerP2(createResearchDeps(Deno.env.toObject(), db), createSupabaseMonitorStore(db.sb)),
      ),
    ),
  );
  return await runLoop({
    db,
    worker,
    now: () => Date.now(),
    t0,
    settings: settings.pipeline,
    stages: p2.stages,
    handlers: p2.handlers,
    seeders: p2.seeders,
    loadRun: async (id) => {
      const run = await loadRun(db.sb, id);
      if (
        run.providerMode === "fixture" &&
        world === undefined &&
        Deno.env.get("ALLOW_FIXTURE_PROVIDERS") === "1"
      )
        world = await loadWorld();
      return run;
    },
    providersFor: (run, onEvent) =>
      createProviders({ run, db, onEvent, ...(world === undefined ? {} : { world }) }),
    activeRunIds: () => activeRunIds(db.sb),
  });
}

/**
 * Worker invocation (7.5). Authenticated by the shared secret (verify_jwt = false, A-07). It answers 202 at once and keeps working through
 * EdgeRuntime.waitUntil, bounded by the 150 s wall clock: stop claiming at 85 s, hard deadline at 120 s, 180 s leases recover a killed worker.
 * `{"wait": true}` (local tools and tests) runs the loop before answering and returns its summary.
 */
Deno.serve(async (req) => {
  const denied = await requireCronSecret(req, Deno.env.get("CRON_SHARED_SECRET") ?? "");
  if (denied !== null) return denied;
  const body =
    req.method === "POST" ? ((await req.json().catch(() => ({}))) as { wait?: boolean }) : {};
  const t0 = Date.now();
  const worker = crypto.randomUUID();
  const work = runWorker(worker, t0, createServiceDb()).catch((e: unknown) => {
    logError("worker-tick failed", e);
    return null;
  });
  if (body.wait === true) return json({ worker, summary: await work });
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ worker }, { status: 202 });
});
