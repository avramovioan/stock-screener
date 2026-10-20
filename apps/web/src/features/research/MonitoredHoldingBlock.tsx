/** A change check never claims a regenerated report (brief 9): the two dates are always shown apart. */
export function MonitoredHoldingBlock({
  fullReportDate,
  lastCheckDate,
}: {
  fullReportDate: string | null;
  lastCheckDate: string | null;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {`Full report: ${fullReportDate ?? "none yet"} · Last change check: ${lastCheckDate ?? "none yet"}`}
    </p>
  );
}
