import type { SupabaseClient } from "@supabase/supabase-js";

export type PushSendLatestResult =
  | { ok: true; digest_id: string; scan_date: string; queued: number; already_sent: number }
  | { ok: true; queued: 0; reason: "no_ready_digest" };

/**
 * Operator action `push_send_latest`: queue the push deliveries of the latest ready public digest (younger than 24 hours) for devices that
 * have none yet, and reset failed or skipped ones. The SQL function does the work and kicks the dispatcher.
 */
export async function pushSendLatest(deps: {
  sb: Pick<SupabaseClient, "rpc">;
}): Promise<PushSendLatestResult> {
  const { data, error } = await deps.sb.rpc("push_queue_latest");
  if (error) throw new Error(`push_queue_failed: ${error.message}`);
  const r = (data ?? {}) as {
    digest_id?: string;
    scan_date?: string;
    queued?: number;
    already_sent?: number;
  };
  if (r.digest_id === undefined) return { ok: true, queued: 0, reason: "no_ready_digest" };
  return {
    ok: true,
    digest_id: r.digest_id,
    scan_date: r.scan_date ?? "",
    queued: r.queued ?? 0,
    already_sent: r.already_sent ?? 0,
  };
}
