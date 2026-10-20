import { useState } from "react";
import { ErrorState, Loading } from "@/components/data-state/data-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult } from "./broker-api";
import { runActive } from "./broker-view";
import { LinkForm } from "./components/link-form";
import { SetupGuide } from "./components/setup-guide";
import { StatusCard } from "./components/status-card";
import { UnlinkDialog } from "./components/unlink-dialog";
import { useBrokerActions, useBrokerSnapshot } from "./use-broker";

function cooldownMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Manual sync is limited to once every 10 minutes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function message(result: ActionResult | undefined): string | null {
  if (result === undefined || result.ok) return null;
  switch (result.kind) {
    case "cooldown":
      return cooldownMessage(result.retryAfterSeconds);
    case "busy":
      return "A sync is already running. Wait for it to finish.";
    case "not_linked":
      return "No broker is linked.";
    case "failed":
      return result.message;
    case "invalid_input":
      return null;
  }
}

export function BrokerSection() {
  const snapshot = useBrokerSnapshot();
  const actions = useBrokerActions();
  const [confirming, setConfirming] = useState(false);
  const [now] = useState(() => new Date());

  if (snapshot.isLoading) return <Loading label="Loading broker status" rows={4} />;
  if (snapshot.isError || snapshot.data === undefined) {
    return (
      <ErrorState
        message="Could not load the broker connection."
        onRetry={() => void snapshot.refetch()}
      />
    );
  }
  const { connection, run } = snapshot.data;
  const linked = connection !== null && connection.status !== "unlinked";
  const busy =
    runActive(run) || actions.link.isPending || actions.test.isPending || actions.sync.isPending;
  const linkResult = actions.link.data;
  const fieldError =
    linkResult !== undefined && !linkResult.ok && linkResult.kind === "invalid_input"
      ? { field: linkResult.field, message: linkResult.message }
      : null;
  const notice =
    message(actions.sync.data) ??
    message(actions.test.data) ??
    message(actions.link.data) ??
    message(actions.unlink.data);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Supported method</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="font-medium">IBKR Flex Web Service, read-only</p>
          <p className="text-muted-foreground">
            Linking and unlinking are recorded in the audit log (never with the token). The token is
            encrypted on the server and is never shown again.
          </p>
        </CardContent>
      </Card>

      <StatusCard connection={connection} run={run} now={now} />

      {notice !== null ? (
        <p role="alert" className="rounded border px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      {linked ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => actions.test.mutate()}
          >
            Test connection
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => actions.sync.mutate()}
          >
            Sync now
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={actions.unlink.isPending}
            onClick={() => setConfirming(true)}
          >
            Unlink
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{linked ? "Replace the token" : "Link your account"}</CardTitle>
        </CardHeader>
        <CardContent>
          <LinkForm
            pending={actions.link.isPending}
            disabled={busy}
            onSubmit={(input) => actions.link.submit(input)}
            fieldError={fieldError}
            now={now}
          />
        </CardContent>
      </Card>

      <SetupGuide />

      <UnlinkDialog
        open={confirming}
        onOpenChange={setConfirming}
        pending={actions.unlink.isPending}
        onConfirm={(o) => actions.unlink.mutate(o, { onSettled: () => setConfirming(false) })}
      />
    </div>
  );
}
