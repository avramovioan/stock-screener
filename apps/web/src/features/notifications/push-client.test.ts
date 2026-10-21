import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOPICS,
  type NotificationsApi,
  NotificationsApiError,
  type Topics,
} from "./notifications-api";
import {
  type BrowserPush,
  disablePush,
  enablePush,
  liveEndpoint,
  reconcilePush,
  renewStaleSubscription,
} from "./push-client";
import { keyFingerprint, readStoredKeyFingerprint, writeStoredKeyFingerprint } from "./topic-store";

const KEY = "AQID";
beforeEach(() => localStorage.clear());
const json = { endpoint: "https://push.example/e1", keys: { p256dh: "k", auth: "a" } };
const BOTH: Topics = { discounts: true, portfolio: true };

function fakes(
  over: {
    permission?: NotificationPermission;
    existing?: boolean;
    subscribeError?: Error;
    existingKey?: number[];
  } = {},
) {
  const sub = {
    options:
      over.existingKey === undefined
        ? undefined
        : { applicationServerKey: new Uint8Array(over.existingKey).buffer },
    endpoint: json.endpoint,
    toJSON: () => json,
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(over.existing ? sub : null),
    subscribe: vi.fn(() =>
      over.subscribeError ? Promise.reject(over.subscribeError) : Promise.resolve(sub),
    ),
  };
  const browser: BrowserPush = {
    requestPermission: vi.fn().mockResolvedValue(over.permission ?? "granted"),
    getRegistration: vi.fn().mockResolvedValue({ pushManager }),
  };
  const api = {
    subscribe: vi.fn().mockResolvedValue(DEFAULT_TOPICS),
    update: vi.fn(),
    status: vi.fn().mockResolvedValue({ subscribed: true, topics: BOTH }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    sendTest: vi.fn(),
  } satisfies NotificationsApi;
  return { browser, api, pushManager, sub };
}

describe("enablePush", () => {
  it("requests permission synchronously (inside the click gesture), subscribes with the key and posts the topics", async () => {
    const { browser, api, pushManager } = fakes();
    const pending = enablePush(browser, api, KEY, DEFAULT_TOPICS);
    expect(browser.requestPermission).toHaveBeenCalledTimes(1); // before any await resolved
    expect(await pending).toEqual({ ok: true, endpoint: json.endpoint, topics: DEFAULT_TOPICS });
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(api.subscribe).toHaveBeenCalledWith(json, DEFAULT_TOPICS);
  });

  it("returns the topics the server stored (a signed-out device never keeps holdings alerts)", async () => {
    const { browser, api } = fakes();
    api.subscribe.mockResolvedValue({ discounts: true, portfolio: false });
    expect(await enablePush(browser, api, KEY, BOTH)).toMatchObject({
      ok: true,
      topics: { discounts: true, portfolio: false },
    });
  });

  it("does nothing when permission is denied or dismissed", async () => {
    for (const [permission, reason] of [
      ["denied", "denied"],
      ["default", "dismissed"],
    ] as const) {
      const { browser, api } = fakes({ permission });
      expect(await enablePush(browser, api, KEY, DEFAULT_TOPICS)).toEqual({ ok: false, reason });
      expect(api.subscribe).not.toHaveBeenCalled();
    }
  });

  it("does not even prompt when the VAPID key is not configured", async () => {
    const { browser, api } = fakes();
    expect(await enablePush(browser, api, undefined, DEFAULT_TOPICS)).toEqual({
      ok: false,
      reason: "no_key",
    });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it("reuses an existing browser subscription and reports subscribe and server failures", async () => {
    writeStoredKeyFingerprint(keyFingerprint(KEY));
    const reuse = fakes({ existing: true });
    expect((await enablePush(reuse.browser, reuse.api, KEY, DEFAULT_TOPICS)).ok).toBe(true);
    expect(reuse.pushManager.subscribe).not.toHaveBeenCalled();
    const broken = fakes({ subscribeError: new Error("push service unreachable") });
    expect(await enablePush(broken.browser, broken.api, KEY, DEFAULT_TOPICS)).toEqual({
      ok: false,
      reason: "subscribe_failed",
    });
    const serverDown = fakes();
    serverDown.api.subscribe.mockRejectedValue(new NotificationsApiError("failed"));
    expect(await enablePush(serverDown.browser, serverDown.api, KEY, DEFAULT_TOPICS)).toEqual({
      ok: false,
      reason: "server_failed",
    });
  });

  it("replaces a subscription made with another key by one made with the current key", async () => {
    const { browser, api, pushManager, sub } = fakes({ existing: true, existingKey: [9, 9, 9] });
    expect((await enablePush(browser, api, KEY, DEFAULT_TOPICS)).ok).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
  });

  it("keeps a subscription made with the current key", async () => {
    const { browser, api, pushManager, sub } = fakes({ existing: true, existingKey: [1, 2, 3] });
    expect((await enablePush(browser, api, KEY, DEFAULT_TOPICS)).ok).toBe(true);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("options missing: a stored fingerprint of the current key keeps the subscription", async () => {
    writeStoredKeyFingerprint(keyFingerprint(KEY));
    const { browser, api, pushManager, sub } = fakes({ existing: true });
    expect((await enablePush(browser, api, KEY, DEFAULT_TOPICS)).ok).toBe(true);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("options missing and no fingerprint: re-subscribes once and stores the fingerprint", async () => {
    const { browser, api, pushManager, sub } = fakes({ existing: true });
    expect((await enablePush(browser, api, KEY, DEFAULT_TOPICS)).ok).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(readStoredKeyFingerprint()).toBe(keyFingerprint(KEY));
    expect(await enablePush(browser, api, KEY, DEFAULT_TOPICS)).toMatchObject({ ok: true });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1); // the second run keeps it
  });

  it("reports the per-account device limit separately", async () => {
    const { browser, api } = fakes();
    api.subscribe.mockRejectedValue(new NotificationsApiError("too_many_subscriptions"));
    expect(await enablePush(browser, api, KEY, DEFAULT_TOPICS)).toEqual({
      ok: false,
      reason: "too_many",
    });
  });
});

describe("liveEndpoint", () => {
  it("is the endpoint of the browser subscription, or null without one", async () => {
    expect(await liveEndpoint(fakes({ existing: true }).browser)).toBe(json.endpoint);
    expect(await liveEndpoint(fakes().browser)).toBeNull();
  });
});

describe("disablePush", () => {
  it("unsubscribes this device in the browser and removes it on the server", async () => {
    const { browser, api, sub } = fakes({ existing: true });
    await disablePush(browser, api);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(api.unsubscribe).toHaveBeenCalledWith(json.endpoint);
  });
  it("is a no-op without a browser subscription", async () => {
    const { browser, api } = fakes();
    await disablePush(browser, api);
    expect(api.unsubscribe).not.toHaveBeenCalled();
  });
});

describe("reconcilePush (page visit)", () => {
  it("re-registers a subscription the server knows, with its stored topics, so the row follows the signed-in user", async () => {
    const { browser, api } = fakes({ existing: true });
    expect(await reconcilePush(browser, api, KEY, "granted")).toBe("synced");
    expect(api.status).toHaveBeenCalledWith(json.endpoint);
    expect(api.subscribe).toHaveBeenCalledWith(json, BOTH);
  });
  it("never creates a subscription: no browser subscription means the device is off", async () => {
    const { browser, api, pushManager } = fakes();
    expect(await reconcilePush(browser, api, KEY, "granted")).toBe("skipped");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
  it("leaves a subscription alone that the server does not know (the owner turned it off)", async () => {
    const { browser, api } = fakes({ existing: true });
    api.status.mockResolvedValue({ subscribed: false, topics: null });
    expect(await reconcilePush(browser, api, KEY, "granted")).toBe("skipped");
    expect(api.subscribe).not.toHaveBeenCalled();
  });
  it("does nothing without a granted permission or a key", async () => {
    const { browser, api } = fakes({ existing: true });
    expect(await reconcilePush(browser, api, KEY, "default")).toBe("skipped");
    expect(await reconcilePush(browser, api, undefined, "granted")).toBe("skipped");
    expect(api.status).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});

describe("renewStaleSubscription (key rotation heals itself)", () => {
  it("replaces a stale subscription the server knows, keeping its topics", async () => {
    const { browser, api, pushManager, sub } = fakes({ existing: true, existingKey: [9, 9, 9] });
    expect(await renewStaleSubscription(browser, api, KEY)).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledWith(json, BOTH);
  });

  it("does nothing for a current key, for a device that is off, and for one the server does not know", async () => {
    const current = fakes({ existing: true, existingKey: [1, 2, 3] });
    expect(await renewStaleSubscription(current.browser, current.api, KEY)).toBe(false);
    const off = fakes({ existing: false });
    expect(await renewStaleSubscription(off.browser, off.api, KEY)).toBe(false);
    const unknown = fakes({ existing: true, existingKey: [9, 9, 9] });
    unknown.api.status.mockResolvedValue({ subscribed: false, topics: null });
    expect(await renewStaleSubscription(unknown.browser, unknown.api, KEY)).toBe(false);
    expect(unknown.sub.unsubscribe).not.toHaveBeenCalled();
  });

  it("runs on page load through reconcilePush", async () => {
    const { browser, api, pushManager } = fakes({ existing: true, existingKey: [9, 9, 9] });
    expect(await reconcilePush(browser, api, KEY, "granted")).toBe("synced");
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });
});
