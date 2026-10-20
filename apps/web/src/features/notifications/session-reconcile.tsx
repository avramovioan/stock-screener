import { useEffect } from "react";
import { useAuth } from "@/features/auth/auth-provider";
import type { NotificationsApi } from "./notifications-api";
import { type BrowserPush, defaultBrowserPush, reconcilePush } from "./push-client";

/** Who the device was last re-registered for in this page session: a user id, or "anonymous". */
let reconciledFor: string | null = null;

/** Test hook: the once-per-session flag is module state. */
export function resetSessionReconcile(): void {
  reconciledFor = null;
}

export interface SessionReconcileDeps {
  getApi(): Promise<NotificationsApi>;
  browser: BrowserPush;
  vapidPublicKey: string | undefined;
  permission(): NotificationPermission | null;
}

// The supabase client is imported lazily; it is only needed once permission is already granted.
function defaultDeps(): SessionReconcileDeps {
  return {
    getApi: async () => {
      const [{ supabase }, { createNotificationsApi }] = await Promise.all([
        import("@/lib/supabase"),
        import("./notifications-api"),
      ]);
      return createNotificationsApi(supabase);
    },
    browser: defaultBrowserPush(),
    vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined,
    permission: () => (typeof Notification === "undefined" ? null : Notification.permission),
  };
}

/**
 * Spec 10.4: pushsubscriptionchange is unreliable, so once per page session, and again when the
 * visitor signs in or out, the live subscription is re-registered (when notifications are on for
 * this device). The signed-in call binds the device to the account; a signed-out call unbinds it.
 */
export function PushSessionReconcile({ deps }: { deps?: SessionReconcileDeps }) {
  const { status, user } = useAuth();
  const who =
    status === "signed-in" && user ? user.id : status === "signed-out" ? "anonymous" : null;
  useEffect(() => {
    if (who === null || reconciledFor === who) return;
    const d = deps ?? defaultDeps();
    if (d.permission() !== "granted" || !d.vapidPublicKey) return;
    reconciledFor = who;
    void (async () => {
      const api = await d.getApi();
      await reconcilePush(d.browser, api, d.vapidPublicKey, "granted");
    })().catch(() => {
      // the next visit reconciles again
    });
  }, [who, deps]);
  return null;
}
