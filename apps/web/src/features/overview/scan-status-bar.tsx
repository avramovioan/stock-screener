import { ErrorState, Skeleton } from "@/components/data-state/data-state";
import { StatusBanner } from "@/components/status/status-banner";
import { errorText } from "@/features/screening/errors";
import { useScanStatus } from "@/features/screening/hooks";
import { formatSofiaShort } from "@/lib/format";
import { deriveScanBanner } from "./scan-banner";

/** The latest published scan time (else the last successful one; never an attempt time), in Sofia time. */
export function ScanStatusBar() {
  const q = useScanStatus();
  if (q.isLoading) return <Skeleton className="h-4 w-48" />;
  if (q.isError)
    return <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />;
  const at =
    q.data?.latest_published?.results_published_at ?? q.data?.last_successful?.finished_at ?? null;
  return (
    <p className="text-[13px] text-muted-foreground">
      {at ? `Last scan ${formatSofiaShort(at)} Sofia time` : "No scan published yet"}
    </p>
  );
}

/** Banner for a partial, failed or stale scan; renders nothing when everything is fine. */
export function ScanBanner() {
  const q = useScanStatus();
  if (!q.data) return null;
  const b = deriveScanBanner(q.data, Date.now());
  return (
    <StatusBanner
      state={b.state}
      processed={"processed" in b ? b.processed : undefined}
      total={"total" in b ? b.total : undefined}
      insufficientData={"insufficientData" in b ? b.insufficientData : undefined}
      skipped={"skipped" in b ? b.skipped : undefined}
      lastScanAt={"lastScanAt" in b ? b.lastScanAt : undefined}
      sessionDate={"sessionDate" in b ? b.sessionDate : undefined}
      ageHours={"ageHours" in b ? b.ageHours : undefined}
    />
  );
}
