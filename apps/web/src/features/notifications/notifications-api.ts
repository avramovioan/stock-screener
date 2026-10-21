import type { SupabaseClient } from "@supabase/supabase-js";

/** What one device wants to hear about. `portfolio` is only honoured for a signed-in subscriber. */
export interface Topics {
  discounts: boolean;
  portfolio: boolean;
}

export const DEFAULT_TOPICS: Topics = { discounts: true, portfolio: false };

export interface DeviceStatus {
  subscribed: boolean;
  topics: Topics | null;
}

export type NotificationsFailure =
  | "too_many_subscriptions"
  | "not_found"
  | "rate_limited"
  | "invalid"
  | "failed";

/** A failed `push-subscribe` call. Only the reason is kept; server text is never shown. */
export class NotificationsApiError extends Error {
  readonly reason: NotificationsFailure;
  constructor(reason: NotificationsFailure) {
    super(`push-subscribe failed: ${reason}`);
    this.name = "NotificationsApiError";
    this.reason = reason;
  }
}

export interface TestOutcome {
  sent: number;
  failed: number;
  /** why a failed test failed: server_keys, rejected (with status) or network */
  reason?: string;
  status?: number;
}

/** Device-keyed API of the `push-subscribe` function: no account is needed, a JWT only binds the row to a user. */
export interface NotificationsApi {
  subscribe(subscription: PushSubscriptionJSON, topics?: Topics): Promise<Topics>;
  update(endpoint: string, topics: Topics): Promise<Topics>;
  status(endpoint: string): Promise<DeviceStatus>;
  unsubscribe(endpoint: string): Promise<void>;
  sendTest(endpoint: string): Promise<TestOutcome>;
}

type Client = Pick<SupabaseClient, "functions">;

const BY_STATUS: Record<number, NotificationsFailure> = {
  400: "invalid",
  404: "not_found",
  409: "too_many_subscriptions",
  429: "rate_limited",
};

function asTopics(value: unknown): Topics | null {
  if (typeof value !== "object" || value === null) return null;
  const { discounts, portfolio } = value as Record<string, unknown>;
  return { discounts: discounts === true, portfolio: portfolio === true };
}

export function createNotificationsApi(client: Client): NotificationsApi {
  async function invoke(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await client.functions.invoke("push-subscribe", { body });
    if (error) {
      const context = (error as { context?: unknown }).context;
      const status = context instanceof Response ? context.status : 0;
      throw new NotificationsApiError(BY_STATUS[status] ?? "failed");
    }
    return (data ?? {}) as Record<string, unknown>;
  }
  return {
    async subscribe(subscription, topics = DEFAULT_TOPICS) {
      const data = await invoke({
        action: "subscribe",
        subscription: { endpoint: subscription.endpoint, keys: subscription.keys },
        topics,
      });
      return asTopics(data.topics) ?? topics;
    },
    async update(endpoint, topics) {
      const data = await invoke({ action: "update", endpoint, topics });
      return asTopics(data.topics) ?? topics;
    },
    async status(endpoint) {
      const data = await invoke({ action: "status", endpoint });
      return { subscribed: data.subscribed === true, topics: asTopics(data.topics) };
    },
    async unsubscribe(endpoint) {
      await invoke({ action: "unsubscribe", endpoint });
    },
    async sendTest(endpoint) {
      const data = await invoke({ action: "test", endpoint });
      return {
        sent: typeof data.sent === "number" ? data.sent : 0,
        failed: typeof data.failed === "number" ? data.failed : 0,
        ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
        ...(typeof data.status === "number" ? { status: data.status } : {}),
      };
    },
  };
}
