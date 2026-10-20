import type { SupabaseClient } from "@supabase/supabase-js";
import { type JobStage, logLine } from "../../_shared/adapters/log.ts";
import type { Handler, Seeder } from "../types.ts";
import { type DigestReason, runDigestStage, sha256Hex } from "./digest-stage.ts";
import { createDigestStore } from "./digest-store.ts";

// Stage 12 (spec 7.4). Job key `digest` runs at scan completion, `digest:cutoff` is seeded by
// app.cutoff_digests() at 13:00 Sofia (spec 7.10). The handler is idempotent: digests_created_at,
// the digest UNIQUE key and the digest_items UNIQUE key make a second run a no-op.
export async function digestHandler(
  job: { scan_run_id: string; key: string },
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const reason: DigestReason = job.key === "digest:cutoff" ? "cutoff" : "complete";
  const result = await runDigestStage(job.scan_run_id, reason, {
    store: createDigestStore(client),
    sha256Hex,
    log: (event, data) => logLine(event, data),
  });
  logLine("digest_stage_done", { ...result });
  return { ...result };
}

export const handleDigest: Handler = (ctx) => digestHandler(ctx.job, ctx.db.sb);

/** The slot after publish:final (app.next_stage_to_seed, migration 20261015004300). */
export const seedDigest: Seeder = () => Promise.resolve({ keys: ["digest"], priorities: [100] });

/** Merges the digest stage into the registries of a worker invocation (one call in `worker-tick/index.ts`). */
export function withDigest<
  T extends {
    stages: readonly JobStage[];
    handlers: Partial<Record<JobStage, Handler>>;
    seeders: Partial<Record<JobStage, Seeder>>;
  },
>(base: T) {
  return {
    stages: base.stages.includes("digest") ? [...base.stages] : [...base.stages, "digest" as const],
    handlers: { ...base.handlers, digest: handleDigest },
    seeders: { ...base.seeders, digest: seedDigest },
  };
}
