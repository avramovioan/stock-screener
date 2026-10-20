import { describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_CHANGED } from "@/sw-push";
import { attachSubscriptionChangeListener } from "./sw-messages";

function fakeTarget() {
  let handler: ((event: MessageEvent) => void) | undefined;
  return {
    target: {
      addEventListener: (_: "message", h: (event: MessageEvent) => void) => {
        handler = h;
      },
    },
    emit: (data: unknown) => handler?.({ data } as MessageEvent),
  };
}

describe("attachSubscriptionChangeListener", () => {
  it("posts a changed subscription to the server", () => {
    const { target, emit } = fakeTarget();
    const post = vi.fn().mockResolvedValue(undefined);
    attachSubscriptionChangeListener(target, post);
    emit({
      type: SUBSCRIPTION_CHANGED,
      subscription: { endpoint: "https://e", keys: { p256dh: "k", auth: "a" } },
    });
    expect(post).toHaveBeenCalledWith({ endpoint: "https://e", keys: { p256dh: "k", auth: "a" } });
  });

  it("ignores other messages and subscriptions without an endpoint", () => {
    const { target, emit } = fakeTarget();
    const post = vi.fn().mockResolvedValue(undefined);
    attachSubscriptionChangeListener(target, post);
    emit({ type: "SKIP_WAITING" });
    emit({ type: SUBSCRIPTION_CHANGED, subscription: {} });
    emit(null);
    expect(post).not.toHaveBeenCalled();
  });
});
