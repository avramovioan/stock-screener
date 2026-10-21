import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/auth-provider";
import { createFakeAuthStore, signedIn, signedOut } from "@/test/auth-fixtures";
import { DEFAULT_TOPICS, type NotificationsApi } from "./notifications-api";
import type { BrowserPush } from "./push-client";
import {
  PushSessionReconcile,
  resetSessionReconcile,
  type SessionReconcileDeps,
} from "./session-reconcile";
import { keyFingerprint, writeStoredKeyFingerprint } from "./topic-store";

const SUB_JSON = { endpoint: "https://push.example/e1", keys: { p256dh: "k", auth: "a" } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(over: { permission?: NotificationPermission | null } = {}) {
  writeStoredKeyFingerprint(keyFingerprint("AQID"));
  const sub = { endpoint: SUB_JSON.endpoint, toJSON: () => SUB_JSON, unsubscribe: vi.fn() };
  const browser: BrowserPush = {
    requestPermission: vi.fn(),
    getRegistration: vi.fn().mockResolvedValue({
      pushManager: { getSubscription: vi.fn().mockResolvedValue(sub), subscribe: vi.fn() },
    }),
  };
  const api = {
    status: vi.fn().mockResolvedValue({ subscribed: true, topics: DEFAULT_TOPICS }),
    subscribe: vi.fn().mockResolvedValue(DEFAULT_TOPICS),
  } as unknown as NotificationsApi;
  const deps: SessionReconcileDeps = {
    getApi: async () => api,
    browser,
    vapidPublicKey: "AQID",
    permission: () => (over.permission === undefined ? "granted" : over.permission),
  };
  return { api, deps };
}

function mount(deps: SessionReconcileDeps, state: Parameters<typeof createFakeAuthStore>[0]) {
  const store = createFakeAuthStore(state);
  render(
    <AuthProvider store={store}>
      <PushSessionReconcile deps={deps} />
    </AuthProvider>,
  );
  return { store };
}

describe("PushSessionReconcile", () => {
  beforeEach(() => resetSessionReconcile());

  it("re-registers the live subscription once per session, also for a signed-out visitor", async () => {
    const { api, deps } = setup();
    mount(deps, signedOut);
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith(SUB_JSON, DEFAULT_TOPICS));
    mount(deps, signedOut); // a second mount in the same session must not run again
    await tick();
    expect(api.subscribe).toHaveBeenCalledTimes(1);
  });

  it("runs again when the visitor signs in, so the device row follows the account", async () => {
    const { api, deps } = setup();
    const { store } = mount(deps, signedOut);
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(1));
    act(() => store.set(signedIn()));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(2));
  });

  it("waits while the auth state is loading", async () => {
    const { api, deps } = setup();
    mount(deps, {});
    await tick();
    expect(api.status).not.toHaveBeenCalled();
  });

  it("skips when the permission is not granted", async () => {
    const { api, deps } = setup({ permission: "default" });
    mount(deps, signedIn());
    await tick();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});
