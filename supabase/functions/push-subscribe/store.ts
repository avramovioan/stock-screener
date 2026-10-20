import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubscribeStore } from "./handler.ts";

export function createSubscribeStore(
  client: SupabaseClient,
  maxSubscriptions: number,
): SubscribeStore {
  return {
    async upsert(userId, sub, topics) {
      // one SQL function: advisory lock + count + upsert, so concurrent subscribes cannot exceed the per-user cap
      // (an anonymous device, userId null, has no cap)
      const { data, error } = await client.rpc("notify_subscribe", {
        p_user: userId,
        p_endpoint: sub.endpoint,
        p_p256dh: sub.p256dh,
        p_auth: sub.auth,
        p_user_agent: sub.userAgent,
        p_max: maxSubscriptions,
        p_discounts: topics.discounts,
        p_portfolio: topics.portfolio,
      });
      if (error) throw new Error(`notify_subscribe failed: ${error.message}`);
      return data === "too_many" ? "too_many" : "ok";
    },
    async update(userId, endpoint, topics) {
      const { data, error } = await client.rpc("notify_update_subscription", {
        p_user: userId,
        p_endpoint: endpoint,
        p_discounts: topics.discounts,
        p_portfolio: topics.portfolio,
      });
      if (error) throw new Error(`notify_update_subscription failed: ${error.message}`);
      return data === true;
    },
    async status(endpoint) {
      const { data, error } = await client
        .from("push_subscriptions")
        .select("topic_discounts,topic_portfolio")
        .eq("endpoint", endpoint)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw new Error(`subscription read failed: ${error.message}`);
      if (data === null) return null;
      const row = data as { topic_discounts: boolean; topic_portfolio: boolean };
      return { discounts: row.topic_discounts, portfolio: row.topic_portfolio };
    },
    async remove(endpoint) {
      const { error } = await client.from("push_subscriptions").delete().eq("endpoint", endpoint);
      if (error) throw new Error(`subscription delete failed: ${error.message}`);
    },
    async claimTest(endpoint) {
      const { data, error } = await client.rpc("notify_claim_endpoint_test", {
        p_endpoint: endpoint,
      });
      if (error) throw new Error(`notify_claim_endpoint_test failed: ${error.message}`);
      const r = data as {
        status: string;
        id?: string;
        endpoint?: string;
        p256dh?: string;
        auth?: string;
      } | null;
      if (r?.status === "ok") {
        return {
          kind: "ok",
          target: {
            id: String(r.id),
            endpoint: String(r.endpoint),
            p256dh: String(r.p256dh),
            auth: String(r.auth),
          },
        };
      }
      return { kind: r?.status === "rate_limited" ? "rate_limited" : "not_found" };
    },
    async mark(id, outcome) {
      const { error } = await client.rpc("notify_mark_subscription", {
        p_id: id,
        p_outcome: outcome,
      });
      if (error) throw new Error(`notify_mark_subscription failed: ${error.message}`);
    },
  };
}
