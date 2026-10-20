import { createServiceDb } from "@adapters/db.ts";
import { json, requireCronSecret } from "@adapters/http.ts";
import { scanEvent } from "@adapters/log.ts";

/**
 * Retention for the P1 tables (6.4): scan_events and terminal scan_jobs after 30 days, quote_cache after 1 day or expiry,
 * universe_membership_events after 90 days. Batched and idempotent (app.purge_expired); signal episodes, cards, scan runs and audit
 * events are never touched. Later phases extend app.purge_expired for their own tables.
 */
Deno.serve(async (req) => {
  const denied = await requireCronSecret(req, Deno.env.get("CRON_SHARED_SECRET") ?? "");
  if (denied !== null) return denied;
  const db = createServiceDb();
  const result = await db.purgeExpired();
  await scanEvent(db, { runId: null }, "cleanup_result", result);
  return json({ ok: true, deleted: result });
});
