import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryWindow } from "@/features/notifications/delivery-window";
import {
  DEFAULT_TOPICS,
  type NotificationsApi,
  NotificationsApiError,
  type Topics,
} from "@/features/notifications/notifications-api";
import type { BrowserPush } from "@/features/notifications/push-client";
import type { SupportEnv } from "@/features/notifications/push-support";
import { readStoredTopics } from "@/features/notifications/topic-store";
import { ProfileNotificationsPage } from "./notifications-page";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ENDPOINT = "https://push.example/e1";
const ENV: SupportEnv = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isSecureContext: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130",
  platform: "Win32",
  maxTouchPoints: 0,
  standalone: false,
  permission: "granted",
};

interface Options {
  live?: boolean;
  status?: { subscribed: boolean; topics: Topics | null };
  env?: Partial<SupportEnv>;
}

function setup(options: Options = {}) {
  const sub = { endpoint: ENDPOINT, toJSON: () => ({}), unsubscribe: vi.fn(async () => true) };
  const browser: BrowserPush = {
    requestPermission: vi.fn(async () => "granted" as const),
    getRegistration: vi.fn(async () => ({
      pushManager: {
        getSubscription: vi.fn(async () => (options.live === false ? null : sub)),
        subscribe: vi.fn(),
      },
    })),
  };
  const api = {
    subscribe: vi.fn(),
    update: vi.fn(async (_e: string, topics: Topics) => topics),
    status: vi.fn(async () => options.status ?? { subscribed: true, topics: DEFAULT_TOPICS }),
    unsubscribe: vi.fn(),
    sendTest: vi.fn(),
  } satisfies NotificationsApi;
  render(
    <ProfileNotificationsPage
      deps={{ api, browser, vapidPublicKey: "AQID", readEnv: () => ({ ...ENV, ...options.env }) }}
    />,
  );
  return { api, browser };
}

const HINT = "Turn on notifications on this device with the bell first.";
const holdings = () =>
  screen.findByRole("switch", { name: "Alerts about my holdings on this device" });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("Profile, Notifications", () => {
  it("shows the heading, the switch and its line, off by default", async () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toBeTruthy();
    expect((await holdings()).getAttribute("aria-checked")).toBe("false");
    const window = deliveryWindow(new Date());
    expect(
      screen.getByText(
        `Once a day, usually between ${window.start} and ${window.end} your time, about the companies you hold.`,
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(HINT)).toBeNull());
  });

  it("reflects the holdings value the server holds for this device", async () => {
    const { api } = setup({
      status: { subscribed: true, topics: { discounts: false, portfolio: true } },
    });
    await waitFor(async () => expect((await holdings()).getAttribute("aria-checked")).toBe("true"));
    expect(api.status).toHaveBeenCalledWith(ENDPOINT);
  });

  it("toggling updates the device keeping the discounts value, and remembers the topics", async () => {
    const { api } = setup({
      status: { subscribed: true, topics: { discounts: false, portfolio: false } },
    });
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    await waitFor(async () =>
      expect(((await holdings()) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(await holdings());
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(ENDPOINT, { discounts: false, portfolio: true }),
    );
    await waitFor(async () => expect((await holdings()).getAttribute("aria-checked")).toBe("true"));
    expect(readStoredTopics()).toEqual({ discounts: false, portfolio: true });
  });

  it("is disabled with the bell hint when this device has no live subscription", async () => {
    const { api } = setup({ live: false });
    expect(await screen.findByText(HINT)).toBeTruthy();
    expect(((await holdings()) as HTMLButtonElement).disabled).toBe(true);
    expect(api.status).not.toHaveBeenCalled();
  });

  it("is disabled with the bell hint when the server does not know the device", async () => {
    setup({ status: { subscribed: false, topics: null } });
    expect(await screen.findByText(HINT)).toBeTruthy();
    expect(((await holdings()) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled with the bell hint when the browser has no push", async () => {
    setup({ env: { hasPushManager: false } });
    expect(await screen.findByText(HINT)).toBeTruthy();
    expect(((await holdings()) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toasts once when saving fails and leaves the switch as it was", async () => {
    const { api } = setup();
    api.update.mockRejectedValueOnce(new NotificationsApiError("failed"));
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    await waitFor(async () =>
      expect(((await holdings()) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(await holdings());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect((await holdings()).getAttribute("aria-checked")).toBe("false");
  });
});
