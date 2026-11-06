import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { ManualUrls, RegulatedResult } from "./regulated-api";

function Box({ tone, children }: { tone: "green" | "red" | "amber"; children: ReactNode }) {
  const Icon = tone === "green" ? CircleCheck : tone === "red" ? CircleX : TriangleAlert;
  return (
    <div
      role="status"
      aria-live="polite"
      data-tone={tone}
      className="status-tag w-full items-start justify-start rounded-md px-3 py-3 text-sm font-normal"
    >
      <Icon aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function ResultBox({ result }: { result: RegulatedResult }) {
  const { isin, mic, exchangeName } = result;
  switch (result.verdict) {
    case "regulated":
      return (
        <Box tone="green">
          <p className="font-semibold">
            {isin} is offered on a regulated market on {mic}
            {result.matchedSegment ? ` (${result.matchedSegment.mic} segment)` : ""}
          </p>
          {result.instrumentName ? <p>Instrument: {result.instrumentName}</p> : null}
          {result.matchedSegment ? <p>Segment: {result.matchedSegment.name}</p> : null}
        </Box>
      );
    case "not-offered":
      return (
        <Box tone="red">
          <p className="font-semibold">Not offered on a regulated segment of {mic}.</p>
          {result.checkedSegments.length > 0 ? (
            <p>Segments checked: {result.checkedSegments.join(", ")}</p>
          ) : null}
        </Box>
      );
    case "no-regulated-segment":
      return (
        <Box tone="red">
          <p className="font-semibold">
            {exchangeName} ({mic}) has no regulated-market segment in the ESMA register, so nothing
            traded there is on a regulated market.
          </p>
        </Box>
      );
    default:
      return (
        <Box tone="red">
          <p className="font-semibold">
            {mic} is not in the ESMA register (e.g. non-EEA venues like LSE or SIX) — try another
            exchange.
          </p>
        </Box>
      );
  }
}

export function UnavailableBox({ manualUrls }: { manualUrls: ManualUrls }) {
  const link = "underline underline-offset-4";
  return (
    <Box tone="amber">
      <p className="font-semibold">
        ESMA is temporarily blocking automated checks, so this one could not run.
      </p>
      <p>You can look it up yourself in the ESMA registers:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <a href={manualUrls.venues} target="_blank" rel="noopener noreferrer" className={link}>
            ESMA venue register (opens in a new tab)
          </a>
        </li>
        <li>
          <a
            href={manualUrls.instruments}
            target="_blank"
            rel="noopener noreferrer"
            className={link}
          >
            ESMA instrument register, FIRDS (opens in a new tab)
          </a>
        </li>
      </ul>
    </Box>
  );
}
