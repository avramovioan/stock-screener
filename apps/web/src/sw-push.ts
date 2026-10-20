export const SUBSCRIPTION_CHANGED = "PUSH_SUBSCRIPTION_CHANGED";

export interface SubscriptionLike {
  toJSON(): PushSubscriptionJSON;
}
export interface SubscriptionChangedMessage {
  type: typeof SUBSCRIPTION_CHANGED;
  subscription: PushSubscriptionJSON;
}

export async function resubscribeAndBroadcast(deps: {
  newSubscription: SubscriptionLike | null;
  subscribe(): Promise<SubscriptionLike>;
  broadcast(message: SubscriptionChangedMessage): Promise<void>;
}): Promise<boolean> {
  try {
    const subscription = deps.newSubscription ?? (await deps.subscribe());
    await deps.broadcast({ type: SUBSCRIPTION_CHANGED, subscription: subscription.toJSON() });
    return true;
  } catch {
    return false;
  }
}
