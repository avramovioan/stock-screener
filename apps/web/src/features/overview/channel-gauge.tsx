import { Check, Hourglass } from "lucide-react";
import type { DiscountRow } from "@/features/screening/types";
import { formatMonthDay } from "@/lib/format";
import { type DiscountTag, discountTag, type GaugeFacts } from "./card-state";
import { closeLabelLeft, mirrorPos } from "./close-label";

const FILL = "color-mix(in srgb, var(--primary) 18%, var(--card))";
const LABEL = "whitespace-nowrap text-xs tabular-nums text-muted-foreground";
const TAG = "inline-flex items-center gap-1.5 self-start rounded-full text-[13px] font-semibold";

function sinceText(row: DiscountRow): string {
  return row.since_date ? `, since ${formatMonthDay(row.since_date)}` : "";
}

/** "8.9% below its −3 line" (bold) + " and 1.9% below its −4 line, since Oct 15." */
function headline(row: DiscountRow, facts: GaugeFacts) {
  return {
    lead: `${facts.below3}% below its \u22123 line`,
    rest: `${facts.below4 ? ` and ${facts.below4}% below its \u22124 line` : ""}${sinceText(row)}.`,
  };
}

/** The close against both lower lines: a sentence plus a decorative track (the sentence and aria-label carry the meaning). */
export function ChannelGauge({ row, facts }: { row: DiscountRow; facts: GaugeFacts }) {
  const { lead, rest } = headline(row, facts);
  // The bar reads the -3 line on the left and the -4 line on the right (price falls to the right), so every position is mirrored.
  const close = mirrorPos(facts.closePos);
  const x3 = mirrorPos(facts.pos3);
  const x4 = mirrorPos(facts.pos4);
  return (
    <figure className="m-0 flex flex-col gap-2.5" aria-label={facts.ariaLabel}>
      <p className="text-sm leading-[1.45]">
        <span className="font-semibold tabular-nums">{lead}</span>
        {rest}
      </p>
      <div aria-hidden="true" className="relative h-[54px]">
        <span
          className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-xs font-semibold tabular-nums text-primary"
          style={{ left: closeLabelLeft(close, facts.closeText) }}
        >
          {facts.closeText}
        </span>
        <div className="absolute inset-x-0 top-6 h-1.5 rounded-[3px] bg-muted" />
        <div
          className="absolute top-6 h-1.5"
          style={{
            left: `${x3}%`,
            width: `${x4 - x3}%`,
            background: FILL,
          }}
        />
        <div className="absolute top-[17px] h-5 w-0.5 bg-foreground" style={{ left: `${x3}%` }} />
        <div
          className="absolute top-[17px] h-5 w-0.5 bg-muted-foreground"
          style={{ left: `${x4}%` }}
        />
        <div
          className="absolute top-5 size-3.5 rounded-full bg-primary shadow-[0_0_0_3px_var(--card)]"
          style={{ left: `calc(${close}% - 7px)` }}
        />
        {facts.merged ? (
          <div
            className={`absolute top-10 flex gap-2 ${LABEL}`}
            style={{ left: `${x3}%` }}
            data-testid="gauge-labels-merged"
          >
            <span>{`\u22123 ${facts.line3Price}`}</span>
            <span>{`\u22124 ${facts.line4Price}`}</span>
          </div>
        ) : (
          <>
            <span
              className={`absolute top-10 -translate-x-1/2 ${LABEL}`}
              style={{ left: `${x4}%` }}
            >
              {`\u22124 ${facts.line4Price}`}
            </span>
            <span
              className={`absolute top-10 -translate-x-1/2 ${LABEL}`}
              style={{ left: `${x3}%` }}
            >
              {`\u22123 ${facts.line3Price}`}
            </span>
          </>
        )}
      </div>
    </figure>
  );
}

/** The factual tag under the gauge: Reached −4 or Wait for −4 (the verdict is in the card header). */
export function DiscountTagBlock({ row, facts }: { row: DiscountRow; facts: GaugeFacts | null }) {
  const tag: DiscountTag | null = discountTag(row);
  if (!tag) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="discount-tag" data-tag={tag}>
      {tag === "reached" ? (
        <p className={`${TAG} border border-primary bg-card px-2.5 py-1 text-primary`}>
          <Check aria-hidden="true" size={14} strokeWidth={2.5} />
          {"Reached \u22124"}
        </p>
      ) : (
        <>
          <p className={`${TAG} border border-input bg-card px-2.5 py-1 text-tag-unavailable-fg`}>
            <Hourglass aria-hidden="true" size={14} />
            {"Wait for \u22124"}
          </p>
          {facts ? (
            <p className="text-[13px] text-muted-foreground">
              {`The \u22124 line, ${facts.line4Price}, is ${facts.lower4}% lower.`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
