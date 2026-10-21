import type { SupabaseClient } from "@supabase/supabase-js";

export type TelegramSendLatestResult =
  | { queued: true; digest_id: string; scan_date: string; note: string }
  | { queued: false; reason: "already_sent" | "no_ready_digest" | "not_configured" };

/**
 * Operator action `telegram_send_latest`: queue the Telegram message of the latest ready public digest (younger than 24 hours). The SQL
 * function does the work and kicks the dispatcher; the minute cron kick is the safety net.
 */
export async function telegramSendLatest(deps: {
  sb: Pick<SupabaseClient, "rpc">;
  configured: boolean;
}): Promise<TelegramSendLatestResult> {
  if (!deps.configured) return { queued: false, reason: "not_configured" };
  const { data, error } = await deps.sb.rpc("telegram_queue_latest");
  if (error) throw new Error(`telegram_queue_failed: ${error.message}`);
  const r = data as {
    queued: boolean;
    reason?: "already_sent" | "no_ready_digest";
    digest_id?: string;
    scan_date?: string;
  };
  if (!r.queued) return { queued: false, reason: r.reason ?? "no_ready_digest" };
  return {
    queued: true,
    digest_id: r.digest_id ?? "",
    scan_date: r.scan_date ?? "",
    note: "sends within a minute",
  };
}
