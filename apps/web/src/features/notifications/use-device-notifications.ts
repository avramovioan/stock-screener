import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_TOPICS,
  type NotificationsApi,
  NotificationsApiError,
  type Topics,
} from "./notifications-api";
import {
  type BrowserPush,
  disablePush,
  type EnableResult,
  enablePush,
  liveEndpoint,
  renewStaleSubscription,
} from "./push-client";
import { detectPushSupport, type PushSupport, type SupportEnv } from "./push-support";
import { writeStoredTopics } from "./topic-store";

export interface DeviceDeps {
  api: NotificationsApi;
  browser: BrowserPush;
  vapidPublicKey: string | undefined;
  readEnv: () => SupportEnv;
}

export interface Notice {
  kind: "status" | "error";
  text: string;
}

const OFF: Topics = { discounts: false, portfolio: false };

const FAILURES: Record<Exclude<EnableResult, { ok: true }>["reason"], string> = {
  no_key: "Notifications are not set up for this site yet.",
  denied: "Notifications were blocked in the browser prompt.",
  dismissed: "The permission prompt was dismissed. Nothing was changed.",
  subscribe_failed: "The browser could not create a push subscription. Try again.",
  server_failed: "The subscription could not be saved. Try again in a moment.",
  too_many: "This account has too many devices registered. Turn one off on another device first.",
};

function testFailureText({ reason, status }: { reason?: string; status?: number }): string {
  if (reason === "server_keys")
    return "The server's push keys are not set up correctly. (Owner: see the go-live runbook, troubleshooting.)";
  if (reason === "rejected" && status === 403)
    return "This phone's subscription does not match the server key. Turn notifications off and on again.";
  if (reason === "network") return "The push service could not be reached. Try again.";
  return "The test could not be delivered. Turn this phone off and on again.";
}

/**
 * State of the bell's sheet: whether THIS browser is registered and for which topics. Every
 * registration call is made synchronously from a click so the permission prompt stays inside the
 * user gesture.
 */
export function useDeviceNotifications(deps: DeviceDeps) {
  const { api, browser, vapidPublicKey, readEnv } = deps;
  const [support, setSupport] = useState<PushSupport>(() => detectPushSupport(readEnv()));
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [topics, setTopics] = useState<Topics>(OFF);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deniedNow, setDeniedNow] = useState(false);
  const generation = useRef(0);

  const register = useCallback(
    async (wanted: Topics) => {
      setNotice(null);
      setBusy(true);
      // enablePush asks for the permission first, before any await.
      const result = await enablePush(browser, api, vapidPublicKey, wanted);
      setSupport(detectPushSupport(readEnv()));
      if (result.ok) {
        setEndpoint(result.endpoint);
        setSubscribed(true);
        setTopics(result.topics);
        writeStoredTopics(result.topics);
      } else {
        if (result.reason === "denied") setDeniedNow(true);
        setNotice({ kind: "error", text: FAILURES[result.reason] });
      }
      setBusy(false);
    },
    [api, browser, vapidPublicKey, readEnv],
  );

  const load = useCallback(async () => {
    const run = ++generation.current;
    setBusy(true);
    try {
      // a rotated VAPID key is healed before the sheet reads the device's state
      await renewStaleSubscription(browser, api, vapidPublicKey).catch(() => false);
      const live = await liveEndpoint(browser);
      const status = live === null ? null : await api.status(live);
      if (run !== generation.current) return;
      if (live !== null && status?.subscribed) {
        setEndpoint(live);
        setSubscribed(true);
        setTopics(status.topics ?? DEFAULT_TOPICS);
        writeStoredTopics(status.topics ?? DEFAULT_TOPICS);
      } else {
        setEndpoint(null);
        setSubscribed(false);
        setTopics(OFF);
      }
    } catch {
      if (run === generation.current) {
        setNotice({ kind: "error", text: "Could not read the settings of this phone. Try again." });
      }
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }, [api, browser, vapidPublicKey]);

  /** Called from the bell's click. Registers the device when nothing was decided yet. */
  const open = useCallback(() => {
    setNotice(null);
    setDeniedNow(false);
    const next = detectPushSupport(readEnv());
    setSupport(next);
    if (next.kind === "prompt") void register(DEFAULT_TOPICS);
    else if (next.kind === "granted") void load();
  }, [readEnv, register, load]);

  const toggle = useCallback(
    async (topic: keyof Topics, on: boolean) => {
      if (!subscribed || endpoint === null) {
        await register({ ...OFF, [topic]: on });
        return;
      }
      const wanted = { ...topics, [topic]: on };
      setNotice(null);
      setBusy(true);
      try {
        const confirmed = await api.update(endpoint, wanted);
        setTopics(confirmed);
        writeStoredTopics(confirmed);
      } catch (error) {
        if (error instanceof NotificationsApiError && error.reason === "not_found") {
          setSubscribed(false);
          setTopics(OFF);
          setNotice({
            kind: "error",
            text: "This phone is not registered any more. Turn a switch on to register it again.",
          });
        } else {
          setNotice({ kind: "error", text: "Could not save the change. Try again." });
        }
      } finally {
        setBusy(false);
      }
    },
    [subscribed, endpoint, topics, api, register],
  );

  const sendTest = useCallback(async () => {
    if (endpoint === null) return;
    setNotice(null);
    setBusy(true);
    try {
      const outcome = await api.sendTest(endpoint);
      setNotice(
        outcome.sent > 0
          ? { kind: "status", text: "Test notification sent." }
          : { kind: "error", text: testFailureText(outcome) },
      );
    } catch (error) {
      const reason = error instanceof NotificationsApiError ? error.reason : "failed";
      if (reason === "not_found") {
        setSubscribed(false);
        setTopics(OFF);
        setNotice({
          kind: "error",
          text: "This phone is not registered any more. Turn a switch on to register it again.",
        });
      } else {
        setNotice({
          kind: "error",
          text:
            reason === "rate_limited"
              ? "One test a minute. Try again shortly."
              : "The test could not be sent. Try again.",
        });
      }
    } finally {
      setBusy(false);
    }
  }, [api, endpoint]);

  const turnOff = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      await disablePush(browser, api);
      setSubscribed(false);
      setEndpoint(null);
      setTopics(OFF);
      writeStoredTopics(null);
    } catch {
      setNotice({ kind: "error", text: "Could not turn this phone off. Try again." });
    } finally {
      setBusy(false);
    }
  }, [browser, api]);

  const effective: PushSupport =
    deniedNow && support.kind !== "unsupported" && support.kind !== "ios_install"
      ? { kind: "denied", isIos: support.isIos, isStandalone: false }
      : support;

  return { support: effective, subscribed, topics, busy, notice, open, toggle, sendTest, turnOff };
}
