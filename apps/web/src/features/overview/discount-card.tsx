import { Link } from "@tanstack/react-router";
import { Ban, Check, TriangleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";
import { CountryFlag } from "@/components/country-flag";
import { FreshnessTag } from "@/components/status/freshness-tag";
import { TRADE_BUTTON_LABEL, TradeOnIbkrButton } from "@/features/handoff/trade-on-ibkr-button";
import type { TradeTarget } from "@/features/handoff/types";
import type { QuoteDto } from "@/features/screening/quotes-api";
import type { DiscountRow } from "@/features/screening/types";
import { formatMonthDay, formatPrice, formatSofiaShort, homeTicker } from "@/lib/format";
import { Provenance } from "./card-notes";
import {
  type CardState,
  cardState,
  cautionSentence,
  flagLabel,
  flagTone,
  gaugeFacts,
  reasonSentence,
  type VerdictTag,
  verdictTag,
} from "./card-state";
import { ChannelGauge, DiscountTagBlock } from "./channel-gauge";
import { ResearchPanel, useScanFinished } from "./research-panel";
import { researchView } from "./research-state";

export { TRADE_BUTTON_LABEL };

const ACTION_LINK = "inline-flex min-h-11 items-center text-sm underline underline-offset-[3px]";
const PILL =
  "inline-flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[13px] font-semibold";

/** The hand-off target of a card: the canonical (screening) listing the card is about. */
export function tradeTarget(row: DiscountRow): TradeTarget {
  return {
    securityId: row.security_id,
    symbol: row.yahoo_symbol,
    companyName: row.name,
    rank: row.rank,
    exchangeName: row.exchange_name,
    currency: row.currency,
  };
}

/** Trade on IBKR for every viewer, signed in or not. It opens the hand-off dialog and never submits anything. */
export function TradeControl({ target }: { target: TradeTarget }) {
  return (
    <TradeOnIbkrButton
      target={target}
      variant="default"
      className="min-h-11 rounded-lg px-[18px] font-semibold"
    />
  );
}

/** Line 2 of the identity block (spec 5.5): "France · Euronext Paris · Yahoo RMS.PA". */
function identityLine(row: DiscountRow): string {
  return [row.country, row.exchange_name, `Yahoo ${row.yahoo_symbol}`]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** The verified EUR listing's delayed price, a separate muted line; null without a verified listing. */
function eurLine(row: DiscountRow, state: CardState, quote: QuoteDto | undefined): string | null {
  if (row.eur_status !== "verified" || !row.eur_symbol_yahoo) return null;
  if (!quote || quote.regularMarketPrice === null) {
    return `${row.eur_symbol_yahoo}, EUR price unavailable.`;
  }
  const price = formatPrice(quote.regularMarketPrice, "EUR");
  const delayed = formatSofiaShort(quote.regularMarketTime);
  return `${row.eur_symbol_yahoo}, ${price}, delayed ${delayed}${quote.stale ? " (stale)" : ""}.`;
}

const VERDICT: Record<VerdictTag, { label: string; tone: string }> = {
  strong: { label: "Strong buy", tone: "green" },
  consider: { label: "Consider", tone: "consider" },
  unchecked: { label: "Unchecked", tone: "grey" },
  avoid: { label: "Avoid", tone: "red" },
};

/** The verdict next to the ticker: what the research and the cleared state add up to. */
function VerdictPill({ tag }: { tag: VerdictTag }) {
  const { label, tone } = VERDICT[tag];
  return (
    <span className="status-tag" data-tone={tone} data-testid="verdict-tag" data-tag={tag}>
      {label}
    </span>
  );
}

function StatePill({ state, row }: { state: CardState; row: DiscountRow }) {
  if (state === "cleared") {
    return (
      <p
        className={`${PILL} border-tag-discounted-border bg-tag-discounted-bg text-tag-discounted-fg`}
        data-testid="card-state"
      >
        <Check aria-hidden="true" size={14} strokeWidth={2.5} />
        Cleared
      </p>
    );
  }
  if (state === "caution") {
    return (
      <p
        className={`${PILL} border-tag-caution-border bg-tag-caution-bg text-tag-caution-fg`}
        data-testid="card-state"
      >
        <TriangleAlert aria-hidden="true" size={14} />
        Cleared with caution
      </p>
    );
  }
  const tone =
    flagTone(row) === "red"
      ? "border-tag-flagged-border bg-tag-flagged-bg text-tag-flagged-fg"
      : "border-tag-unavailable-border bg-tag-unavailable-bg text-tag-unavailable-fg";
  return (
    <p className={`${PILL} ${tone}`} data-testid="card-state">
      <Ban aria-hidden="true" size={14} />
      {`Flagged: ${flagLabel(row)}`}
    </p>
  );
}

function ReportLink({ row }: { row: DiscountRow }) {
  if (!row.report_id) return null;
  return (
    <p className="text-[13px]">
      <Link
        to="/research/$reportId"
        params={{ reportId: row.report_id }}
        className="-my-3 inline-flex min-h-11 items-center underline underline-offset-[3px]"
      >
        Read the full report
      </Link>
    </p>
  );
}

function Verdict({ row }: { row: DiscountRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Conclusion</dt>
      <dd className="font-medium">{row.conclusion ?? "Not assessed"}</dd>
      <dt className="text-muted-foreground">Bankruptcy risk</dt>
      <dd className="font-medium">{row.bankruptcy_risk ?? "Not assessed"}</dd>
    </dl>
  );
}

function StateBlock({
  row,
  state,
  now,
}: {
  row: DiscountRow;
  state: CardState;
  now: Date | undefined;
}) {
  // A card without a verdict (the research panel below carries its state).
  if (state === "pending") return null;
  const caution = state === "caution" ? cautionSentence(row) : null;
  // A flagged card reads like the others; only its tags differ, and the reason stands in when there is no summary.
  const text =
    state === "flagged"
      ? (row.summary ?? reasonSentence(row))
      : [caution, row.summary].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-2.5">
      <StatePill state={state} row={row} />
      {text ? <p className="text-sm leading-normal">{text}</p> : null}
      <Verdict row={row} />
      <Provenance row={row} now={now} />
      <ReportLink row={row} />
    </div>
  );
}

function Footer({ row }: { row: DiscountRow }) {
  const right: ReactNode = <TradeControl target={tradeTarget(row)} />;
  return (
    <footer className="mt-auto flex flex-col gap-1 border-t pt-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2 sm:pt-3">
      <Link
        to="/quotes"
        search={{ symbol: row.yahoo_symbol, sid: row.security_id }}
        className={ACTION_LINK}
      >
        Show on graph
      </Link>
      {right}
    </footer>
  );
}

export function DiscountCard({
  row,
  eurQuote,
  now,
}: {
  row: DiscountRow;
  eurQuote?: QuoteDto | undefined;
  /** Test hook: a fixed "now" for the relative times. */
  now?: Date | undefined;
}) {
  const headingId = useId();
  const state = cardState(row);
  const facts = gaugeFacts(row);
  const eur = eurLine(row, state, eurQuote);
  const verdict = verdictTag(row, researchView(row, now ?? new Date()));
  const ticker = homeTicker(row.yahoo_symbol, row.exchange_code, row.listing_country);
  const justFinished = useScanFinished(row, ticker, now);
  return (
    <article
      aria-labelledby={headingId}
      data-testid="discount-card"
      data-symbol={row.yahoo_symbol}
      data-state={state}
      data-just-finished={justFinished}
      className={`flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-4 text-card-foreground transition-shadow sm:gap-4 sm:p-5 ${justFinished ? "border-primary ring-[3px] ring-primary/30" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h2 id={headingId} className="flex items-baseline gap-2">
            <span className="text-[15px] font-medium tracking-normal text-muted-foreground">{`#${row.rank}`}</span>{" "}
            <span className="text-[22px] font-semibold tracking-[0.01em] sm:text-2xl">
              {ticker}
            </span>
          </h2>
          <VerdictPill tag={verdict} />
        </div>
        <div className="text-right tabular-nums">
          <p className="text-[22px] font-semibold sm:text-2xl">
            {formatPrice(row.close, row.currency)}
          </p>
          {row.data_freshness === "fresh" ? (
            <p className="text-[13px] text-muted-foreground">{`Close, ${formatMonthDay(row.session_date)}`}</p>
          ) : (
            <FreshnessTag freshness={row.data_freshness} sessionDate={row.session_date} />
          )}
        </div>
      </div>
      <div className="-mt-1.5 flex flex-col gap-0.5">
        <p className="text-base font-medium">{row.name}</p>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <CountryFlag country={row.country} />
          <span>{identityLine(row)}</span>
        </p>
        {eur ? <p className="text-[13px] text-muted-foreground">{eur}</p> : null}
      </div>
      {facts ? <ChannelGauge row={row} facts={facts} /> : null}
      <DiscountTagBlock row={row} facts={facts} />
      <StateBlock row={row} state={state} now={now} />
      <ResearchPanel row={row} now={now} />
      <Footer row={row} />
    </article>
  );
}
