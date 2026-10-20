import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/auth-provider";
import { createFakeAuthStore, signedIn, signedOut } from "@/test/auth-fixtures";
import { deliveryWindow } from "./delivery-window";
import {
  DEFAULT_TOPICS,
  type NotificationsApi,
  NotificationsApiError,
  type Topics,
} from "./notifications-api";
import { NotificationsBell } from "./notifications-bell";
import type { BrowserPush } from "./push-client";
import type { SupportEnv } from "./push-support";
import { readStoredTopics } from "./topic-store";

const ENDPOINT = "https://push.example/e1";
const SUB_JSON = { endpoint: ENDPOINT, keys: { p256dh: "k", auth: "a" } };

const DESKTOP: SupportEnv = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isSecureContext: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130",
  platform: "Win32",
  maxTouchPoints: 0,
  standalone: false,
  permission: "default",
};
const IPHONE: SupportEnv = {
  ...DESKTOP,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
  hasNotification: false,
};

interface Options {
  env?: Partial<SupportEnv>;
  base?: SupportEnv;
  live?: boolean;
  status?: { subscribed: boolean; topics: Topics | null };
  prompt?: NotificationPermission;
  vapid?: string | undefined;
  auth?: Parameters<typeof createFakeAuthStore>[0];
}

function setup(options: Options = {}) {
  const env: SupportEnv = { ...(options.base ?? DESKTOP), ...options.env };
  let live = options.live ?? false;
  const sub = {
    endpoint: ENDPOINT,
    toJSON: () => SUB_JSON,
    unsubscribe: vi.fn(async () => {
      live = false;
      return true;
    }),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => (live ? sub : null)),
    subscribe: vi.fn(async () => {
      live = true;
      return sub;
    }),
  };
  const browser: BrowserPush = {
    requestPermission: vi.fn(async () => options.prompt ?? "granted"),
    getRegistration: vi.fn(async () => ({ pushManager })),
  };
  const api = {
    subscribe: vi.fn(async (_s: unknown, topics: Topics = DEFAULT_TOPICS) => topics),
    update: vi.fn(async (_e: string, topics: Topics) => topics),
    status: vi.fn(async () => options.status ?? { subscribed: false, topics: null }),
    unsubscribe: vi.fn(async () => undefined),
    sendTest: vi.fn(async () => ({ sent: 1, failed: 0 })),
  } satisfies NotificationsApi;
  const deps = {
    api,
    browser,
    readEnv: () => env,
    vapidPublicKey: "vapid" in options ? options.vapid : "AQID",
  };
  const store = createFakeAuthStore(options.auth ?? signedOut);
  render(
    <AuthProvider store={store}>
      <NotificationsBell deps={deps} />
    </AuthProvider>,
  );
  return { api, browser, pushManager, sub, store };
}

const bell = () => screen.getByRole("button", { name: "Notifications on this device" });
const sheet = () => screen.findByRole("dialog");
const discounts = () => screen.getByRole("switch", { name: "New companies on the list" });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("the bell", () => {
  it("is in the header for a signed-out visitor and opens nothing until clicked", () => {
    setup();
    expect(bell()).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the sheet with the board's texts", async () => {
    const window = deliveryWindow(new Date());
    setup();
    fireEvent.click(bell());
    const dialog = await sheet();
    expect(
      within(dialog).getByRole("heading", { name: "Notifications on this phone" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "No account needed. Each phone or browser is registered on its own.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("New companies on the list")).toBeTruthy();
    expect(
      within(dialog).getByText(
        `Once a day, usually between ${window.start} and ${window.end} your time, after the daily check. Only when something is new.`,
      ),
    ).toBeTruthy();
    expect(within(dialog).getAllByRole("switch")).toHaveLength(1);
    expect(within(dialog).queryByText("Alerts about my holdings")).toBeNull();
    expect(within(dialog).queryByText("Only when you are signed in.")).toBeNull();
  });
});

describe("registering this device", () => {
  it("asks for permission inside the click and registers with the public digest on", async () => {
    const { api, browser } = setup();
    fireEvent.click(bell());
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith(SUB_JSON, DEFAULT_TOPICS));
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("button", { name: "Send a test notification" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off on this phone" })).toBeTruthy();
  });

  it("signed in: the bell has no holdings switch and a discounts toggle keeps the holdings value", async () => {
    const { api } = setup({
      env: { permission: "granted" },
      live: true,
      status: { subscribed: true, topics: { discounts: true, portfolio: true } },
      auth: signedIn(),
    });
    fireEvent.click(bell());
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("switch", { name: "Alerts about my holdings" })).toBeNull();
    fireEvent.click(discounts());
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ENDPOINT, { discounts: false, portfolio: true }),
    );
    fireEvent.click(discounts());
    await waitFor(() =>
      expect(api.update).toHaveBeenLastCalledWith(ENDPOINT, { discounts: true, portfolio: true }),
    );
  });

  it("shows the topics the server holds for an already registered device, without prompting", async () => {
    const { api, browser } = setup({
      env: { permission: "granted" },
      live: true,
      status: { subscribed: true, topics: { discounts: false, portfolio: true } },
      auth: signedIn(),
    });
    fireEvent.click(bell());
    await waitFor(() => expect(api.status).toHaveBeenCalledWith(ENDPOINT));
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("false"));
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it("a device that was turned off stays off when the sheet opens; a switch turns it on", async () => {
    const { api } = setup({ env: { permission: "granted" }, live: false });
    fireEvent.click(bell());
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("false"));
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send a test notification" })).toBeNull();
    fireEvent.click(discounts());
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith(SUB_JSON, DEFAULT_TOPICS));
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("true"));
  });

  it("says so when the permission prompt is dismissed and registers nothing", async () => {
    const { api } = setup({ prompt: "default" });
    fireEvent.click(bell());
    expect(await screen.findByText(/prompt was dismissed/i)).toBeTruthy();
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(discounts().getAttribute("aria-checked")).toBe("false");
  });

  it("explains a blocked permission and leaves the switches off", async () => {
    setup({ env: { permission: "denied" } });
    fireEvent.click(bell());
    expect(await screen.findByText(/set Notifications to Allow/i)).toBeTruthy();
    expect((discounts() as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains the per-account device limit", async () => {
    const { api } = setup({ auth: signedIn() });
    api.subscribe.mockRejectedValue(new NotificationsApiError("too_many_subscriptions"));
    fireEvent.click(bell());
    expect(await screen.findByText(/too many devices/i)).toBeTruthy();
  });
});

describe("remembering the topics for a rotated endpoint", () => {
  it("stores the confirmed topics on subscribe and update, and clears them on turn off", async () => {
    setup({ auth: signedIn() });
    fireEvent.click(bell());
    await waitFor(() => expect(readStoredTopics()).toEqual(DEFAULT_TOPICS));
    fireEvent.click(await screen.findByRole("switch", { name: "New companies on the list" }));
    await waitFor(() => expect(readStoredTopics()).toEqual({ discounts: false, portfolio: false }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off on this phone" }));
    await waitFor(() => expect(readStoredTopics()).toBeNull());
  });
});

describe("test and turn off", () => {
  it("sends the test to this endpoint only", async () => {
    const { api } = setup();
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole("button", { name: "Send a test notification" }));
    await waitFor(() => expect(api.sendTest).toHaveBeenCalledWith(ENDPOINT));
    expect(await screen.findByText("Test notification sent.")).toBeTruthy();
  });

  it("reports a rate-limited test and a device the server no longer knows", async () => {
    const { api } = setup();
    fireEvent.click(bell());
    const test = await screen.findByRole("button", { name: "Send a test notification" });
    api.sendTest.mockRejectedValueOnce(new NotificationsApiError("rate_limited"));
    fireEvent.click(test);
    expect(await screen.findByText(/one test a minute/i)).toBeTruthy();
    api.sendTest.mockRejectedValueOnce(new NotificationsApiError("not_found"));
    fireEvent.click(test);
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByRole("button", { name: "Send a test notification" })).toBeNull();
  });

  it("turns this phone off: browser and server, and the switches go off", async () => {
    const { api, sub } = setup();
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole("button", { name: "Turn off on this phone" }));
    await waitFor(() => expect(api.unsubscribe).toHaveBeenCalledWith(ENDPOINT));
    expect(sub.unsubscribe).toHaveBeenCalled();
    await waitFor(() => expect(discounts().getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByRole("button", { name: "Turn off on this phone" })).toBeNull();
  });
});

describe("support", () => {
  const NOTE =
    "iPhone: open this site in Safari, tap Share, then Add to Home Screen. Open it from the new icon and turn notifications on there.";

  it("shows the iPhone note only on iOS when the site is not installed", async () => {
    setup({ base: IPHONE });
    fireEvent.click(bell());
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it("hides the iPhone note on iOS when installed and everywhere else", async () => {
    const installed = setup({
      base: IPHONE,
      env: { standalone: true, hasNotification: true, permission: "granted" },
    });
    fireEvent.click(bell());
    await sheet();
    expect(screen.queryByText(NOTE)).toBeNull();
    installed.store.dispose();
  });

  it("hides the iPhone note on a desktop browser", async () => {
    setup();
    fireEvent.click(bell());
    await sheet();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("says when the browser cannot do push", async () => {
    setup({ env: { hasPushManager: false } });
    fireEvent.click(bell());
    expect(await screen.findByText(/not available in this browser/i)).toBeTruthy();
  });

  it("says when push is not configured, without prompting", async () => {
    const { browser } = setup({ vapid: undefined });
    fireEvent.click(bell());
    expect(await screen.findByText(/not set up for this site yet/i)).toBeTruthy();
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });
});
