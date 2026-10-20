/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";
import { urlBase64ToUint8Array } from "./lib/vapid-key";
import { focusOrOpen } from "./sw-click";
import { resubscribeAndBroadcast } from "./sw-push";
import {
  isNeverCached,
  NAVIGATION_DENYLIST,
  parsePushPayload,
  resolveNotificationUrl,
} from "./sw-routes";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// 1. Precache only the static build output.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

// 2. Never cache API, auth or function responses (see sw-routes.ts for the rules and tests).
registerRoute(
  ({ url, request }) => isNeverCached(url, request.headers, self.location.origin),
  new NetworkOnly(),
);

// 3. SPA navigation fallback, except for auth callbacks and function/REST paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: NAVIGATION_DENYLIST }),
);

// 4. "Update available" toast posts SKIP_WAITING (registerType: "prompt").
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

// 5. Push: ALWAYS show a notification (iOS revokes subscriptions that stay silent).
self.addEventListener("push", (event) => {
  let text = "";
  try {
    text = event.data?.text() ?? "";
  } catch {
    // unreadable payload: parsePushPayload falls back to the default notification
  }
  const payload = parsePushPayload(text);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
      ...(payload.tag === undefined ? {} : { tag: payload.tag }),
    }),
  );
});

// 6. Click: focus an open window and navigate it, otherwise open one (same-origin targets only).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  event.waitUntil(
    focusOrOpen(self.clients, resolveNotificationUrl(data?.url, self.location.origin)),
  );
});

// 7. Subscription rotation. The SW cannot authenticate, so it re-subscribes and hands the new
//    subscription to open pages (features/notifications/sw-messages.ts POSTs it to push-subscribe).
interface SubscriptionChangeEvent extends ExtendableEvent {
  newSubscription?: PushSubscription | null;
}
self.addEventListener("pushsubscriptionchange", (event) => {
  const change = event as SubscriptionChangeEvent;
  const key = (import.meta.env as Record<string, string | undefined>).VITE_VAPID_PUBLIC_KEY;
  change.waitUntil(
    resubscribeAndBroadcast({
      newSubscription: change.newSubscription ?? null,
      subscribe: () => {
        if (!key) return Promise.reject(new Error("VITE_VAPID_PUBLIC_KEY is not set"));
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      },
      broadcast: async (message) => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) client.postMessage(message);
      },
    }),
  );
});
