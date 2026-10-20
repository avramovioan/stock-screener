import { Sparkle } from "lucide-react";
import { InfoBox as InfoPopover } from "@/features/portfolio/page/info-box";
import type { DiscountRow } from "@/features/screening/types";
import { formatSofiaShort } from "@/lib/format";
import { modelDisplayName } from "@/lib/model-names";
import { relativeTime, useNow } from "@/lib/relative-time";

/** "2 hours ago" with the absolute Sofia time as its title; the text refreshes every minute. */
export function RelativeTime({ iso, now }: { iso: string; now?: Date | undefined }) {
  const tick = useNow();
  return (
    <time dateTime={iso} title={`${formatSofiaShort(iso)} Sofia time`}>
      {relativeTime(iso, now ?? tick)}
    </time>
  );
}

/** Who researched it and how long ago (every card with a completed report). */
export function Provenance({ row, now }: { row: DiscountRow; now?: Date | undefined }) {
  if (!row.research_completed_at) return null;
  const model = row.research_model ? modelDisplayName(row.research_model) : null;
  const why = fallbackSentence(row);
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <Sparkle aria-hidden="true" size={14} className="shrink-0" />
      <span>
        {model ? `Researched by ${model}, ` : "Researched "}
        <RelativeTime iso={row.research_completed_at} now={now} />.
      </span>
      {why ? (
        <InfoPopover label="Why the backup model was used" active className="w-72">
          <p>{why}</p>
        </InfoPopover>
      ) : null}
    </p>
  );
}

const FALLBACK_BECAUSE: Record<string, string> = {
  primary_unavailable: "Gemini was overloaded",
  primary_quota: "Gemini's free daily quota was used up",
  primary_rate_limited: "Gemini was rate limited",
};

/**
 * "GPT-OSS 120B, the backup model, wrote this report because Gemini was overloaded." When the backup's request budget cut the
 * evidence: "... wrote this report from a shorter evidence set because Gemini was overloaded."
 */
export function fallbackSentence(row: DiscountRow): string | null {
  const because = row.fallback_reason ? FALLBACK_BECAUSE[row.fallback_reason] : undefined;
  if (!because) return null;
  const who = row.research_model
    ? `${modelDisplayName(row.research_model)}, the backup model,`
    : "The backup model";
  const shorter = row.evidence_trimmed === true ? " from a shorter evidence set" : "";
  return `${who} wrote this report${shorter} because ${because}.`;
}
