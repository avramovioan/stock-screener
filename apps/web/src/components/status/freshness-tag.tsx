import { Ban, Clock } from "lucide-react";
import { formatSessionDate } from "@/lib/format";

export type FreshnessValue = "fresh" | "stale" | "unavailable";

/** fresh: plain "close {date}"; stale: amber "Stale" tag with the date; unavailable: grey tag. */
export function FreshnessTag({
  freshness,
  sessionDate,
}: {
  freshness: FreshnessValue | null | undefined;
  sessionDate?: string | null | undefined;
}) {
  if (freshness === "fresh") {
    return (
      <span className="text-xs text-muted-foreground">{`close ${formatSessionDate(sessionDate)}`}</span>
    );
  }
  if (freshness === "stale") {
    return (
      <span className="status-tag" data-tone="amber" data-testid="freshness-stale">
        <Clock aria-hidden="true" size={14} />
        <span>{`Stale: close ${formatSessionDate(sessionDate)}`}</span>
      </span>
    );
  }
  return (
    <span className="status-tag" data-tone="grey" data-testid="freshness-unavailable">
      <Ban aria-hidden="true" size={14} />
      <span>Unavailable</span>
    </span>
  );
}
