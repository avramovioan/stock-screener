import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimedDelivery,
  ClaimedTelegram,
  Completion,
  DispatchStore,
  TelegramCompletion,
} from "./dispatch.ts";

export function createDispatchStore(client: SupabaseClient): DispatchStore {
  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name} failed: ${error.message}`);
    return data;
  }
  return {
    async claim(limit) {
      return ((await rpc("notify_claim_deliveries", { p_limit: limit })) ??
        []) as ClaimedDelivery[];
    },
    async subscriptions(userId, kind) {
      const rows = ((await rpc("notify_active_subscriptions", { p_user: userId, p_kind: kind })) ??
        []) as {
        id: string;
        endpoint: string;
        p256dh: string;
        auth: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        p256dh: r.p256dh,
        auth: r.auth,
      }));
    },
    async deviceSubscription(subscriptionId) {
      const rows = ((await rpc("notify_device_subscription", { p_id: subscriptionId })) ?? []) as {
        id: string;
        endpoint: string;
        p256dh: string;
        auth: string;
      }[];
      const r = rows[0];
      return r === undefined
        ? null
        : { id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth };
    },
    async markSubscription(id, outcome) {
      await rpc("notify_mark_subscription", { p_id: id, p_outcome: outcome });
    },
    async claimTelegram(limit) {
      return ((await rpc("notify_telegram_claim", { p_limit: limit })) ?? []) as ClaimedTelegram[];
    },
    async completeTelegram(id, c: TelegramCompletion) {
      await rpc("notify_telegram_complete", {
        p_id: id,
        p_status: c.status,
        p_error: c.error ?? null,
        p_message_id: c.messageId ?? null,
        p_retry_in_seconds: c.retryInSeconds ?? null,
      });
    },
    async complete(id, c: Completion) {
      await rpc("notify_complete_delivery", {
        p_id: id,
        p_status: c.status,
        p_skip_reason: c.skipReason ?? null,
        p_error: c.error ?? null,
        p_message_id: c.messageId ?? null,
        p_retry_in_seconds: c.retryInSeconds ?? null,
        p_log: c.log,
      });
    },
  };
}
