import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { defaultDeviceDeps } from "@/features/notifications/default-deps";
import { deliveryWindow } from "@/features/notifications/delivery-window";
import { DEFAULT_TOPICS, type Topics } from "@/features/notifications/notifications-api";
import { liveEndpoint } from "@/features/notifications/push-client";
import { detectPushSupport } from "@/features/notifications/push-support";
import { writeStoredTopics } from "@/features/notifications/topic-store";
import type { DeviceDeps } from "@/features/notifications/use-device-notifications";

interface Device {
  endpoint: string;
  topics: Topics;
}

/** Profile, Notifications (signed in): the holdings alerts of THIS device. The bell owns registering it. */
export function ProfileNotificationsPage({ deps }: { deps?: DeviceDeps }) {
  const { api, browser, readEnv } = useMemo(() => deps ?? defaultDeviceDeps(), [deps]);
  const window = useMemo(() => deliveryWindow(new Date()), []);
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        if (detectPushSupport(readEnv()).kind === "unsupported") return;
        const endpoint = await liveEndpoint(browser);
        if (endpoint === null) return;
        const status = await api.status(endpoint);
        if (current && status.subscribed) {
          setDevice({ endpoint, topics: status.topics ?? DEFAULT_TOPICS });
        }
      } catch {
        // an unreadable device is shown as "not turned on here"
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [api, browser, readEnv]);

  async function toggle(portfolio: boolean) {
    if (device === null) return;
    setBusy(true);
    try {
      const confirmed = await api.update(device.endpoint, {
        discounts: device.topics.discounts,
        portfolio,
      });
      setDevice({ endpoint: device.endpoint, topics: confirmed });
      writeStoredTopics(confirmed);
    } catch {
      toast.error("Could not save the change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="page-title" className="max-w-2xl space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Notifications
      </h1>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] font-medium">Alerts about my holdings on this device</p>
          <p className="text-[13px] text-muted-foreground">
            {`Once a day, usually between ${window.start} and ${window.end} your time, about the companies you hold.`}
          </p>
        </div>
        <Switch
          aria-label="Alerts about my holdings on this device"
          checked={device?.topics.portfolio ?? false}
          disabled={device === null || busy}
          onCheckedChange={(next) => void toggle(next)}
          className="shrink-0"
        />
      </div>
      {!loading && device === null ? (
        <p className="rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
          Turn on notifications on this device with the bell first.
        </p>
      ) : null}
    </section>
  );
}
