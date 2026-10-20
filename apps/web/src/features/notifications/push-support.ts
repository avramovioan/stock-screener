export interface SupportEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isSecureContext: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  permission: NotificationPermission | null;
}

export type PushSupport =
  | {
      kind: "unsupported";
      reason: "insecure_context" | "no_service_worker" | "no_push_manager";
      isIos: boolean;
    }
  | { kind: "ios_install"; isIos: true; isStandalone: false }
  | { kind: "denied" | "prompt" | "granted"; isIos: boolean; isStandalone: boolean };

export function readSupportEnv(): SupportEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const displayStandalone =
    typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  const hasNotification = typeof Notification !== "undefined";
  return {
    hasServiceWorker: "serviceWorker" in nav,
    hasPushManager: typeof PushManager !== "undefined",
    hasNotification,
    isSecureContext: typeof isSecureContext === "boolean" ? isSecureContext : true,
    userAgent: nav.userAgent ?? "",
    platform: nav.platform ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || displayStandalone,
    permission: hasNotification ? Notification.permission : null,
  };
}

export function detectPushSupport(env: SupportEnv): PushSupport {
  const isIos =
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (env.platform === "MacIntel" && env.maxTouchPoints > 1);
  if (isIos && !env.standalone) return { kind: "ios_install", isIos: true, isStandalone: false };
  if (!env.isSecureContext) return { kind: "unsupported", reason: "insecure_context", isIos };
  if (!env.hasServiceWorker) return { kind: "unsupported", reason: "no_service_worker", isIos };
  if (!env.hasPushManager || !env.hasNotification) {
    return { kind: "unsupported", reason: "no_push_manager", isIos };
  }
  const kind =
    env.permission === "denied" ? "denied" : env.permission === "granted" ? "granted" : "prompt";
  return { kind, isIos, isStandalone: env.standalone };
}
