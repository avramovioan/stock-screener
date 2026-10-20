import { Info, TriangleAlert } from "lucide-react";
import { formatSessionDate, formatSofia } from "@/lib/format";

export type BannerState = "ok" | "partial" | "failed" | "stale" | "none";

type BannerProps = {
  state: BannerState;
  processed?: number | undefined;
  total?: number | undefined;
  /** Candidates with a price history shorter than the channel: never members, left out of the denominator. */
  insufficientData?: number | undefined;
  /** Listings skipped for missing price data: left out of the denominator. */
  skipped?: number | undefined;
  /** stale only: ISO time of the last completed scan, latest session date and its age in whole hours. */
  lastScanAt?: string | undefined;
  sessionDate?: string | null | undefined;
  ageHours?: number | undefined;
};

function coverageText(p: BannerProps): string {
  if (p.processed === undefined || p.total === undefined) return "";
  const excluded = p.insufficientData ?? 0;
  const skipped = p.skipped ?? 0;
  let text = `${p.processed} of ${p.total - excluded - skipped} securities processed`;
  if (excluded > 0) text += `. ${excluded} excluded for short price history`;
  if (skipped > 0) text += `. ${skipped} skipped for missing price data`;
  return text;
}

export function bannerMessage(p: BannerProps): string | null {
  switch (p.state) {
    case "partial":
      return coverageText(p)
        ? `Latest update incomplete: ${coverageText(p)}. Results may be missing; nothing unprocessed is shown as passing.`
        : "Latest update incomplete. Results may be missing; nothing unprocessed is shown as passing.";
    case "failed":
      return `${
        coverageText(p) ? `Latest scan failed: ${coverageText(p)}.` : "Latest scan failed."
      } Showing results from the last completed scan.`;
    case "stale": {
      const when = p.lastScanAt ? formatSofia(p.lastScanAt) : "unknown";
      const age = p.ageHours !== undefined ? `, ${p.ageHours} hours ago` : "";
      const session = p.sessionDate ? ` Latest session ${formatSessionDate(p.sessionDate)}.` : "";
      const cov = coverageText(p) ? ` ${coverageText(p)}.` : "";
      return `Data is stale: last completed scan ${when}${age}.${session}${cov}`;
    }
    case "none":
      return "No scan published yet. Results will appear after the first scan finishes.";
    default:
      return null;
  }
}

export function StatusBanner(props: BannerProps) {
  const message = bannerMessage(props);
  if (!message) return null;
  const tone = props.state === "none" ? "pending" : "amber";
  const Icon = props.state === "none" ? Info : TriangleAlert;
  return (
    <div
      role="status"
      aria-live="polite"
      className="status-tag w-full justify-start rounded-md px-3 py-2 text-sm font-medium"
      data-tone={tone}
      data-testid={`banner-${props.state}`}
    >
      <Icon aria-hidden="true" size={16} className="shrink-0" />
      <span>{message}</span>
    </div>
  );
}
