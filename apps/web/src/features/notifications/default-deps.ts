import { createNotificationsApi, type NotificationsApi } from "./notifications-api";
import { defaultBrowserPush } from "./push-client";
import { readSupportEnv } from "./push-support";
import type { DeviceDeps } from "./use-device-notifications";

// The supabase client is imported lazily so that importing the bell never builds a client
// (component tests of the app shell do not provide Supabase environment variables).
async function real(): Promise<NotificationsApi> {
  const { supabase } = await import("@/lib/supabase");
  return createNotificationsApi(supabase);
}

const lazyApi: NotificationsApi = {
  subscribe: async (subscription, topics) => (await real()).subscribe(subscription, topics),
  update: async (endpoint, topics) => (await real()).update(endpoint, topics),
  status: async (endpoint) => (await real()).status(endpoint),
  unsubscribe: async (endpoint) => (await real()).unsubscribe(endpoint),
  sendTest: async (endpoint) => (await real()).sendTest(endpoint),
};

export function defaultDeviceDeps(): DeviceDeps {
  return {
    api: lazyApi,
    browser: defaultBrowserPush(),
    vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined,
    readEnv: readSupportEnv,
  };
}
