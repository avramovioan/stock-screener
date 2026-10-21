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

const KEY_FINGERPRINT = "device-push-key";

/** A short, non-secret fingerprint (FNV-1a) of the public VAPID key a subscription was made with. */
export function keyFingerprint(publicKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < publicKey.length; i++) {
    hash ^= publicKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** The fingerprint of the VAPID key this browser's current subscription was made with, if known. */
export function readStoredKeyFingerprint(): string | null {
  try {
    return storage()?.getItem(KEY_FINGERPRINT) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredKeyFingerprint(fingerprint: string | null): void {
  try {
    if (fingerprint === null) storage()?.removeItem(KEY_FINGERPRINT);
    else storage()?.setItem(KEY_FINGERPRINT, fingerprint);
  } catch {
    // blocked storage: the subscription is renewed again on the next check
  }
}
