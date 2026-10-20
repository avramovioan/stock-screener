import { DEFAULT_TOPICS, type NotificationsApi, type Topics } from "./notifications-api";

const KEY = "device-push-topics";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The last topics the server confirmed for this browser. A rotated endpoint is re-registered by the
 * open page (the service worker only broadcasts the new subscription), so page storage is enough.
 */
export function readStoredTopics(): Topics | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Topics>;
    return { discounts: value.discounts === true, portfolio: value.portfolio === true };
  } catch {
    return null;
  }
}

export function writeStoredTopics(topics: Topics | null): void {
  try {
    if (topics === null) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, JSON.stringify(topics));
  } catch {
    // private mode or blocked storage: the defaults apply on rotation
  }
}

/** pushsubscriptionchange: register the new endpoint with the remembered topics (defaults when none). */
export async function resubscribeKeepingTopics(
  api: NotificationsApi,
  subscription: PushSubscriptionJSON,
): Promise<void> {
  const stored = await api.subscribe(subscription, readStoredTopics() ?? DEFAULT_TOPICS);
  writeStoredTopics(stored);
}
