import { urlBase64ToUint8Array } from "@/lib/vapid-key";
import {
  DEFAULT_TOPICS,
  type NotificationsApi,
  NotificationsApiError,
  type Topics,
} from "./notifications-api";

export interface SubscriptionLike {
  endpoint: string;
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
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
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
  const registration = await browser.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return "skipped";
  const status = await api.status(subscription.endpoint);
  if (!status.subscribed) return "skipped";
  await api.subscribe(subscription.toJSON(), status.topics ?? DEFAULT_TOPICS);
  return "synced";
}
