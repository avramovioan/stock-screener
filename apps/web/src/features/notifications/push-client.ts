import { urlBase64ToUint8Array } from "@/lib/vapid-key";
import {
  DEFAULT_TOPICS,
  type NotificationsApi,
  NotificationsApiError,
  type Topics,
} from "./notifications-api";
import {
  keyFingerprint,
  readStoredKeyFingerprint,
  readStoredTopics,
  writeStoredKeyFingerprint,
  writeStoredTopics,
} from "./topic-store";

export interface SubscriptionLike {
  endpoint: string;
  /** not exposed by every browser */
  options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}
export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: BufferSource;
    }): Promise<SubscriptionLike>;
  };
}
export interface BrowserPush {
  requestPermission(): Promise<NotificationPermission>;
  getRegistration(): Promise<PushRegistrationLike>;
}

export function defaultBrowserPush(): BrowserPush {
  return {
    requestPermission: () => Notification.requestPermission(),
    getRegistration: async () =>
      (await navigator.serviceWorker.ready) as unknown as PushRegistrationLike,
  };
}

export type EnableResult =
  | { ok: true; endpoint: string; topics: Topics }
  | {
      ok: false;
      reason: "no_key" | "denied" | "dismissed" | "subscribe_failed" | "server_failed" | "too_many";
    };

/**
 * True when the subscription was (or may have been) made with another key. The browser's own record
 * of the key wins; when it does not expose one, the fingerprint stored at subscribe time decides, and
 * a subscription with no fingerprint counts as stale (it is renewed once).
 */
function isStale(subscription: SubscriptionLike, current: Uint8Array, publicKey: string): boolean {
  const used = subscription.options?.applicationServerKey;
  if (used && used.byteLength > 0) {
    const bytes = new Uint8Array(used);
    return bytes.length !== current.length || bytes.some((b, i) => b !== current[i]);
  }
  return readStoredKeyFingerprint() !== keyFingerprint(publicKey);
}

async function subscribeWith(
  registration: PushRegistrationLike,
  key: Uint8Array<ArrayBuffer>,
  publicKey: string,
): Promise<SubscriptionLike> {
  const created = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  writeStoredKeyFingerprint(keyFingerprint(publicKey));
  return created;
}

/**
 * Must be called directly from the click handler: browsers (iOS in particular) only show the
 * permission prompt for a call made inside the user gesture, so requestPermission() is the first
 * thing that runs, before any await.
 */
export async function enablePush(
  browser: BrowserPush,
  api: NotificationsApi,
  vapidPublicKey: string | undefined,
  topics: Topics,
): Promise<EnableResult> {
  if (!vapidPublicKey) return { ok: false, reason: "no_key" };
  const permission = await browser.requestPermission();
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission !== "granted") return { ok: false, reason: "dismissed" };
  let subscription: SubscriptionLike;
  try {
    const registration = await browser.getRegistration();
    const key = urlBase64ToUint8Array(vapidPublicKey);
    let existing = await registration.pushManager.getSubscription();
    // a subscription made with another key (rotated VAPID keys) can never receive our pushes
    if (existing !== null && isStale(existing, key, vapidPublicKey)) {
      await existing.unsubscribe();
      existing = null;
    }
    subscription = existing ?? (await subscribeWith(registration, key, vapidPublicKey));
  } catch {
    return { ok: false, reason: "subscribe_failed" };
  }
  try {
    const stored = await api.subscribe(subscription.toJSON(), topics);
    return { ok: true, endpoint: subscription.endpoint, topics: stored };
  } catch (error) {
    const tooMany =
      error instanceof NotificationsApiError && error.reason === "too_many_subscriptions";
    return { ok: false, reason: tooMany ? "too_many" : "server_failed" };
  }
}

/** The endpoint of this browser's live push subscription, or null when it has none. */
export async function liveEndpoint(browser: BrowserPush): Promise<string | null> {
  const registration = await browser.getRegistration();
  return (await registration.pushManager.getSubscription())?.endpoint ?? null;
}

export async function disablePush(browser: BrowserPush, api: NotificationsApi): Promise<void> {
  const registration = await browser.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  writeStoredKeyFingerprint(null);
  await api.unsubscribe(endpoint);
}

/**
 * Spec 10.4: pushsubscriptionchange is unreliable, so every visit re-registers the live subscription
 * (with the topics the server holds), which also binds the row to the user who is signed in now.
 * It never creates a subscription: no live subscription, or one the server does not know, is "off".
 */
export async function reconcilePush(
  browser: BrowserPush,
  api: NotificationsApi,
  vapidPublicKey: string | undefined,
  permission: NotificationPermission | null,
): Promise<"synced" | "skipped"> {
  if (permission !== "granted" || !vapidPublicKey) return "skipped";
  await renewStaleSubscription(browser, api, vapidPublicKey);
  const registration = await browser.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return "skipped";
  const status = await api.status(subscription.endpoint);
  if (!status.subscribed) return "skipped";
  await api.subscribe(subscription.toJSON(), status.topics ?? DEFAULT_TOPICS);
  return "synced";
}

/**
 * Heals a key rotation: a subscription the server knows but that was made with another VAPID key
 * is replaced by one made with the current key (same topics, the old row is removed). Never creates
 * a subscription for a device that is off. Returns true when it renewed one.
 */
export async function renewStaleSubscription(
  browser: BrowserPush,
  api: NotificationsApi,
  vapidPublicKey: string | undefined,
): Promise<boolean> {
  if (!vapidPublicKey) return false;
  const registration = await browser.getRegistration();
  const existing = await registration.pushManager.getSubscription();
  if (existing === null) return false;
  const key = urlBase64ToUint8Array(vapidPublicKey);
  if (!isStale(existing, key, vapidPublicKey)) return false;
  const status = await api.status(existing.endpoint);
  if (!status.subscribed) return false;
  const topics = status.topics ?? readStoredTopics() ?? DEFAULT_TOPICS;
  await existing.unsubscribe();
  const created = await subscribeWith(registration, key, vapidPublicKey);
  const stored = await api.subscribe(created.toJSON(), topics);
  writeStoredTopics(stored);
  if (created.endpoint !== existing.endpoint) await api.unsubscribe(existing.endpoint);
  return true;
}
