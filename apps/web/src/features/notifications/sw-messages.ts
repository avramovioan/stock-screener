import { SUBSCRIPTION_CHANGED } from "@/sw-push";

export function attachSubscriptionChangeListener(
  target: { addEventListener(type: "message", handler: (event: MessageEvent) => void): void },
  post: (subscription: PushSubscriptionJSON) => Promise<void>,
): void {
  target.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; subscription?: PushSubscriptionJSON } | null;
    if (data?.type !== SUBSCRIPTION_CHANGED || typeof data.subscription?.endpoint !== "string") {
      return;
    }
    void post(data.subscription).catch(() => {
      // the next visit reconciles the subscription
    });
  });
}
