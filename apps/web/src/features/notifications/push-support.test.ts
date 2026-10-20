import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPushSupport, readSupportEnv, type SupportEnv } from "./push-support";

const DESKTOP: SupportEnv = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isSecureContext: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130",
  platform: "Win32",
  maxTouchPoints: 0,
  standalone: false,
  permission: "default",
};
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";

describe("detectPushSupport", () => {
  it("is ready to ask on a capable desktop browser", () => {
    expect(detectPushSupport(DESKTOP).kind).toBe("prompt");
    expect(detectPushSupport({ ...DESKTOP, permission: "granted" }).kind).toBe("granted");
  });
  it("reports a denied permission with how to reset it", () => {
    expect(detectPushSupport({ ...DESKTOP, permission: "denied" }).kind).toBe("denied");
  });
  it("reports why a browser is unsupported", () => {
    expect(detectPushSupport({ ...DESKTOP, hasPushManager: false })).toMatchObject({
      kind: "unsupported",
      reason: "no_push_manager",
    });
    expect(detectPushSupport({ ...DESKTOP, hasServiceWorker: false })).toMatchObject({
      kind: "unsupported",
      reason: "no_service_worker",
    });
    expect(detectPushSupport({ ...DESKTOP, isSecureContext: false })).toMatchObject({
      kind: "unsupported",
      reason: "insecure_context",
    });
    expect(detectPushSupport({ ...DESKTOP, hasNotification: false })).toMatchObject({
      kind: "unsupported",
    });
  });
  it("asks iOS Safari users to install first (no PushManager outside the Home Screen app)", () => {
    const safari = {
      ...DESKTOP,
      userAgent: IPHONE_UA,
      platform: "iPhone",
      maxTouchPoints: 5,
      hasPushManager: false,
      hasNotification: false,
      permission: null,
    };
    expect(detectPushSupport(safari)).toMatchObject({
      kind: "ios_install",
      isIos: true,
      isStandalone: false,
    });
  });
  it("detects iPadOS that presents a desktop Mac user agent", () => {
    const ipad = {
      ...DESKTOP,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
      hasPushManager: false,
    };
    expect(detectPushSupport(ipad).kind).toBe("ios_install");
  });
  it("treats an installed iOS app as capable, and an old installed iOS as unsupported", () => {
    const installed = {
      ...DESKTOP,
      userAgent: IPHONE_UA,
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
    };
    expect(detectPushSupport(installed).kind).toBe("prompt");
    expect(detectPushSupport({ ...installed, hasPushManager: false })).toMatchObject({
      kind: "unsupported",
      reason: "no_push_manager",
      isIos: true,
    });
  });
  it("a real Mac desktop is not mistaken for an iPad", () => {
    expect(detectPushSupport({ ...DESKTOP, platform: "MacIntel", maxTouchPoints: 0 }).kind).toBe(
      "prompt",
    );
  });
});

describe("readSupportEnv", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads Notification, PushManager and navigator.standalone from the globals", () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("navigator", {
      serviceWorker: {},
      userAgent: IPHONE_UA,
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const env = readSupportEnv();
    expect(env).toMatchObject({
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
      standalone: true,
      permission: "granted",
    });
  });

  it("falls back to the display-mode media query for installed Android and desktop PWAs", () => {
    vi.stubGlobal("navigator", {
      serviceWorker: {},
      userAgent: "Android Chrome",
      platform: "Linux",
      maxTouchPoints: 5,
    });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: standalone)" }));
    expect(readSupportEnv().standalone).toBe(true);
  });

  it("reports missing APIs as false", () => {
    vi.stubGlobal("navigator", { userAgent: "x", platform: "x", maxTouchPoints: 0 });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const env = readSupportEnv();
    expect(env.hasServiceWorker).toBe(false);
  });
});
