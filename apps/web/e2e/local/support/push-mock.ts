import type { Page } from "@playwright/test";

/**
 * A fake Push API in the page: Chromium cannot reach a real push service from a test. The `push-subscribe` function is the real one and
 * accepts the endpoint because the e2e env lists its host in PUSH_ENDPOINT_EXTRA_HOSTS.
 */
export async function installFakePush(page: Page, endpoint: string): Promise<void> {
  await page.addInitScript((ep: string) => {
    const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
    const b64url = (u8: Uint8Array) =>
      btoa(String.fromCharCode(...u8))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const p256dh = b64url(bytes(65, 4));
    const auth = b64url(bytes(16, 7));
    let current: unknown = null;
    const subscription = () => ({
      endpoint: ep,
      expirationTime: null,
      getKey: (name: string) =>
        name === "p256dh" ? bytes(65, 4).buffer : name === "auth" ? bytes(16, 7).buffer : null,
      toJSON: () => ({ endpoint: ep, expirationTime: null, keys: { p256dh, auth } }),
      unsubscribe: async () => {
        current = null;
        return true;
      },
    });
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async () => {
        current = subscription();
        return current;
      },
      permissionState: async () => "granted",
    };
    const registration = {
      pushManager,
      scope: "/",
      active: {},
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => registration,
        getRegistration: async () => registration,
        addEventListener() {},
        removeEventListener() {},
        controller: null,
      },
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: function PushManager() {},
    });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: Object.assign(function Notification() {}, {
        permission: "granted",
        requestPermission: async () => "granted",
      }),
    });
  }, endpoint);
}
