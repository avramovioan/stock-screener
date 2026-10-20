import { describe, expect, it, vi } from "vitest";
import { resubscribeAndBroadcast, SUBSCRIPTION_CHANGED } from "./sw-push";

const json = (endpoint: string): PushSubscriptionJSON => ({
  endpoint,
  keys: { p256dh: "k", auth: "a" },
});

describe("resubscribeAndBroadcast", () => {
  it("broadcasts the browser-provided new subscription without subscribing again", async () => {
    const subscribe = vi.fn();
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const ok = await resubscribeAndBroadcast({
      newSubscription: { toJSON: () => json("https://new") },
      subscribe,
      broadcast,
    });
    expect(ok).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({
      type: SUBSCRIPTION_CHANGED,
      subscription: json("https://new"),
    });
  });

  it("subscribes itself when the event carries no new subscription", async () => {
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => json("https://made") });
    const broadcast = vi.fn().mockResolvedValue(undefined);
    expect(await resubscribeAndBroadcast({ newSubscription: null, subscribe, broadcast })).toBe(
      true,
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: SUBSCRIPTION_CHANGED,
      subscription: json("https://made"),
    });
  });

  it("returns false and broadcasts nothing when subscribing fails", async () => {
    const broadcast = vi.fn();
    const ok = await resubscribeAndBroadcast({
      newSubscription: null,
      subscribe: () => Promise.reject(new Error("denied")),
      broadcast,
    });
    expect(ok).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
