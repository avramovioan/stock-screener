import { AlertTriangle, CheckCircle2, Clock, Loader2, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSessionDate, formatSofia } from "@/lib/format";
import type { BrokerConnection, BrokerRun } from "../broker-api";
import { describeConnection, runActive, type StatusIcon, tokenExpiry } from "../broker-view";
import { ErrorHint } from "./error-hint";
import { SectionChecklist } from "./section-checklist";

const ICONS: Record<StatusIcon, typeof Clock> = {
  "plug-off": PlugZap,
  check: CheckCircle2,
  alert: AlertTriangle,
  clock: Clock,
  loader: Loader2,
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export function StatusCard({
  connection,
  run,
  now,
}: {
  connection: BrokerConnection | null;
  run: BrokerRun | null;
  now: Date;
}) {
  const d = describeConnection(connection, run);
  const Icon = ICONS[d.icon];
  const expiry = connection === null ? null : tokenExpiry(connection.token_expires_on, now);
  const linkedLike = connection !== null && connection.status !== "unlinked";
  const sections = run?.rows_summary.sections;
  const showError = connection !== null && connection.last_error_code !== null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Connection status</CardTitle>
        <Badge variant="outline" className="gap-1">
          <Icon
            aria-hidden="true"
            size={14}
            className={
              d.icon === "loader" || runActive(run) ? "animate-spin motion-reduce:animate-none" : ""
            }
          />
          {d.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {d.detail !== null ? <p role="status">{d.detail}</p> : null}
        {expiry !== null ? (
          <p role="alert" className="rounded border px-2 py-1">
            {expiry.kind === "soon"
              ? `Your Flex token expires in ${expiry.days} day${expiry.days === 1 ? "" : "s"}. Create a new token in Client Portal and link again before then.`
              : `Your Flex token expired ${expiry.days === 0 ? "today" : `${expiry.days} day${expiry.days === 1 ? "" : "s"} ago`}. Create a new token and link again.`}
          </p>
        ) : null}
        {linkedLike && connection !== null ? (
          <dl>
            <Row label="Account">{connection.account_id_masked ?? "pending"}</Row>
            <Row label="Base currency">{connection.base_currency ?? "pending"}</Row>
            <Row label="Last verified">
              {connection.last_verified_at === null
                ? "never"
                : formatSofia(connection.last_verified_at)}
            </Row>
            <Row label="Last sync">
              {connection.last_sync_at === null ? "never" : formatSofia(connection.last_sync_at)}
            </Row>
            <Row label="Last statement date">
              {connection.last_statement_date === null
                ? "none yet"
                : formatSessionDate(connection.last_statement_date)}
            </Row>
          </dl>
        ) : null}
        {linkedLike && connection?.coverage_from ? (
          <p className="text-muted-foreground">{`History loaded from ${formatSessionDate(connection.coverage_from)}: earlier activity is not included.`}</p>
        ) : null}
        {showError && connection !== null ? (
          <div className="space-y-2 rounded border p-2">
            <ErrorHint code={connection.last_error_code} />
            {connection.last_error_at !== null ? (
              <p className="text-xs text-muted-foreground">{`Last error: ${formatSofia(connection.last_error_at)}`}</p>
            ) : null}
          </div>
        ) : null}
        {sections !== undefined && sections.length > 0 && run?.state === "failed" ? (
          <SectionChecklist sections={sections} />
        ) : null}
      </CardContent>
    </Card>
  );
}
