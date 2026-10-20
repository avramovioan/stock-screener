import { Bell } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { DENIED_HELP, IOS_NOTE } from "./copy";
import { defaultDeviceDeps } from "./default-deps";
import { deliveryWindow } from "./delivery-window";
import { type DeviceDeps, useDeviceNotifications } from "./use-device-notifications";

// A bottom sheet on phones, a centred dialog from `sm` up.
const SHEET =
  "gap-3.5 p-4 sm:max-w-md sm:p-6 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-[20px] max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom";

function TopicRow({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[15px] font-medium">{title}</p>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="shrink-0"
      />
    </div>
  );
}

/**
 * The bell in the app header, for every viewer. It opens the notifications sheet for this browser
 * and registers the device when nothing was decided yet. No account is needed.
 */
export function NotificationsBell({ deps }: { deps?: DeviceDeps }) {
  const resolved = useMemo(() => deps ?? defaultDeviceDeps(), [deps]);
  const window = useMemo(() => deliveryWindow(new Date()), []);
  const [open, setOpen] = useState(false);
  const device = useDeviceNotifications(resolved);
  const { support, subscribed, topics, busy, notice } = device;

  const unsupported = support.kind === "unsupported";
  const locked = support.kind === "denied" || support.kind === "ios_install";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11 text-primary"
        aria-label="Notifications on this device"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          device.open();
        }}
      >
        <Bell className="size-5" aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={SHEET}>
          <div aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-border sm:hidden" />
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg">Notifications on this phone</DialogTitle>
            <DialogDescription>
              No account needed. Each phone or browser is registered on its own.
            </DialogDescription>
          </DialogHeader>

          {unsupported ? (
            <p className="text-sm text-muted-foreground">
              Notifications are not available in this browser.{" "}
              {support.reason === "insecure_context" && "They need a secure (https) connection."}
              {support.reason === "no_service_worker" &&
                "This browser does not support service workers."}
              {support.reason === "no_push_manager" &&
                (support.isIos
                  ? "Update to iOS or iPadOS 16.4 or later."
                  : "Try a current version of Chrome, Edge, Firefox or Safari.")}
            </p>
          ) : (
            <>
              <TopicRow
                title="New companies on the list"
                hint={`Once a day, usually between ${window.start} and ${window.end} your time, after the daily check. Only when something is new.`}
                checked={topics.discounts}
                disabled={busy || locked}
                onChange={(next) => void device.toggle("discounts", next)}
              />
              {subscribed ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 border-primary font-semibold text-primary"
                  disabled={busy}
                  onClick={() => void device.sendTest()}
                >
                  Send a test notification
                </Button>
              ) : null}
            </>
          )}

          {support.kind === "ios_install" ? (
            <p className="rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
              {IOS_NOTE}
            </p>
          ) : null}
          {support.kind === "denied" ? (
            <p className="rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
              {DENIED_HELP}
            </p>
          ) : null}
          {notice ? (
            <p
              role={notice.kind === "error" ? "alert" : "status"}
              className={`text-sm ${notice.kind === "error" ? "font-medium text-destructive" : ""}`}
            >
              {notice.text}
            </p>
          ) : null}
          {subscribed ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center self-center rounded-sm text-sm text-primary underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              disabled={busy}
              onClick={() => void device.turnOff()}
            >
              Turn off on this phone
            </button>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
