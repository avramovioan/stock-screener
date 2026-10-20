import type { PositionView } from "@core/portfolio-view.ts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { holdingTarget } from "@/features/handoff/holding-target";
import { TradeOnIbkrButton } from "@/features/handoff/trade-on-ibkr-button";
import { MonitoredHoldingBlock } from "@/features/research/MonitoredHoldingBlock";
import { decodeXmlEntities, formatSessionDate, formatSofia, homeTicker } from "@/lib/format";
import { formatAmount } from "../money-text";
import { HoldingActions } from "./holding-actions";
import type { HoldingLink } from "./holdings-api";
import { FactList, InfoBox } from "./info-box";

export const tone = (v: number) =>
  v > 0 ? "text-emerald-800 dark:text-emerald-400" : v < 0 ? "text-red-700 dark:text-red-400" : "";

export const signedAmount = (v: number, ccy: string) =>
  `${v > 0 ? "+" : ""}${formatAmount(v)} ${ccy}`;

/** Where the price comes from: the delayed quote with its time, the statement close, or why there is none. */
export function priceSourceLine(row: PositionView): string {
  const s = row.price.source;
  return s.kind === "delayed_quote"
    ? `Delayed quote, ${formatSofia(row.quoteTime)}${s.marketState === null ? "" : `, ${s.marketState}`}`
    : s.kind === "statement_close"
      ? `Statement close, ${formatSessionDate(s.reportDate)}`
      : s.reason;
}

/** The broker's FIFO figure at the statement close, "not reported" without one. */
export const brokerPnl = (row: PositionView): string =>
  row.unrealizedBroker === null ? "not reported" : signedAmount(row.unrealizedBroker, row.currency);

/** The facts behind a row's price, value and unrealized figures (the price ⓘ of the table). */
export function priceFacts(row: PositionView, base: string): Array<readonly [string, ReactNode]> {
  const s = row.price.source;
  const fx =
    row.fxSource === "yahoo"
      ? `the Yahoo rate of ${formatSessionDate(row.fxDate)}`
      : row.fxSource === "flex"
        ? `the statement rate of ${formatSessionDate(row.fxDate)}`
        : null;
  const converted =
    row.currency !== base && row.valueBase.kind === "ok" && fx !== null
      ? `, converted: ≈ ${formatAmount(row.valueBase.value)} ${base} at ${fx}`
      : "";
  const facts: Array<readonly [string, ReactNode]> = [["Source", priceSourceLine(row)]];
  if (s.kind === "statement_close")
    facts.push(["Statement close", formatSessionDate(s.reportDate)]);
  facts.push(["Value", `Calculated by this app: quantity × price${converted}`]);
  facts.push([
    "Unrealized P&L",
    `Calculated by this app. Broker-reported FIFO at the statement close: ${brokerPnl(row)}`,
  ]);
  if (row.reconciles !== null)
    facts.push([
      "Reconciles",
      row.reconciles
        ? "Reconciles with the broker figure"
        : "Does not reconcile with the broker figure",
    ]);
  if (row.price.note !== null) facts.push(["Note", row.price.note]);
  if (row.tagBasis !== null) facts.push(["Valuation", row.tagBasis]);
  return facts;
}

const isScreened = (link: HoldingLink | undefined): link is HoldingLink =>
  link !== undefined && link.securityId !== null && link.symbol !== null;

/** "AAPL on NASDAQ · rank 4", or "Not a screened company". */
export function screenedLine(link: HoldingLink | undefined): string {
  if (!isScreened(link)) return "Not a screened company";
  const name = link.screened?.exchangeName ?? link.screened?.exchangeCode ?? null;
  return `${homeTicker(link.symbol as string, link.screened?.exchangeCode)}${name === null ? "" : ` on ${name}`}${link.screened?.rank == null ? "" : ` · rank ${link.screened.rank}`}`;
}

/** The cost basis as the broker reports it. */
export const costBasisLine = (row: PositionView): string =>
  row.costBasis.kind === "ok"
    ? `${formatAmount(row.costBasis.value)} ${row.costBasis.ccy}, broker-reported`
    : "unavailable, broker-reported";

/** The research state of a monitored holding and the link to its full report, or null. */
export function researchFact(
  row: PositionView,
  link: HoldingLink | undefined,
): readonly [string, ReactNode] | null {
  if (link?.monitor == null) return null;
  return [
    "Research",
    <div key="research" data-testid={`holding-research-${row.ticker}`} className="space-y-0.5">
      <MonitoredHoldingBlock
        fullReportDate={link.monitor.fullReportDate}
        lastCheckDate={link.monitor.lastCheckDate}
      />
      {link.monitor.reportId !== null ? (
        <Link
          to="/research/$reportId"
          params={{ reportId: link.monitor.reportId }}
          className="inline-flex min-h-11 items-center text-xs underline md:min-h-0"
        >
          {`Open full report for ${row.ticker}`}
        </Link>
      ) : null}
    </div>,
  ];
}

/** The ticker with its ⓘ: the company name, the held line, the screened listing, the cost basis and the research state. */
export function TickerCell({
  row,
  link,
  testId = "row-ticker",
}: {
  row: PositionView;
  link: HoldingLink | undefined;
  testId?: string;
}) {
  const held = link?.held;
  const exchange = held?.listingExchange ?? null;
  const isin = link?.isin ?? null;
  const heldLine = `${held?.symbol ?? row.ticker}${exchange === null ? "" : ` on ${exchange}`}, ${held?.currency ?? row.currency}${isin === null ? "" : ` · ISIN ${isin}`}`;
  const facts: Array<readonly [string, ReactNode]> = [
    ["Held as", heldLine],
    [isScreened(link) ? "Screened as" : "Screened", screenedLine(link)],
    ["Cost basis", costBasisLine(row)],
  ];
  const research = researchFact(row, link);
  if (research !== null) facts.push(research);
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold">
      <span data-testid={testId}>{row.ticker}</span>
      <InfoBox label={`About ${row.ticker}`} className="w-[360px] max-w-[calc(100vw-2rem)]">
        <p className="text-sm font-semibold">{decodeXmlEntities(row.name ?? row.ticker)}</p>
        <FactList facts={facts} />
      </InfoBox>
    </span>
  );
}

/**
 * The Trade on IBKR button of one held line with the re-evaluate and copy-the-prompt icon buttons beneath, on every row once the link data has loaded. A screened holding targets its company's canonical
 * listing; any other targets the held instrument itself (statement symbol, listing exchange, conid).
 */
export function TradeCell({
  row,
  link,
  links,
  onRevalued,
  reportDate = null,
  layout = "stack",
}: {
  row: PositionView;
  link: HoldingLink | undefined;
  links: ReadonlyMap<number, HoldingLink> | undefined;
  onRevalued?: (() => void) | undefined;
  /** the statement date of the portfolio, shown on the dialog's position card */
  reportDate?: string | null | undefined;
  /** "stack" (the table): Trade over the icon buttons; "row" (phone cards): Trade fills the row, the icon buttons beside it */
  layout?: "stack" | "row";
}) {
  if (links === undefined) return null;
  const target = holdingTarget({
    canonicalSecurityId: link?.securityId ?? null,
    canonicalSymbol: link?.symbol ?? null,
    companyName: decodeXmlEntities(row.name ?? row.ticker),
    currency: row.currency,
    held: {
      symbol: link?.held?.symbol ?? row.ticker,
      listingExchange: link?.held?.listingExchange ?? null,
      conid: row.conid,
      description: row.name === null ? null : decodeXmlEntities(row.name),
      currency: link?.held?.currency ?? row.currency,
      isin: link?.isin ?? null,
    },
    position: {
      quantity: row.quantity,
      averageCost: row.averageCost,
      currency: row.currency,
      marketValue: row.marketValue,
      unrealized: row.unrealizedIndependent,
      heldSymbol: link?.held?.symbol ?? row.ticker,
      heldExchange: link?.held?.listingExchange ?? null,
      reportDate,
    },
  });
  if (layout === "row")
    return (
      <div className="flex items-center gap-2">
        {target === null ? null : <TradeOnIbkrButton target={target} className="min-h-11 flex-1" />}
        <HoldingActions row={row} link={link} onRevalued={onRevalued} />
      </div>
    );
  return (
    <div className="inline-flex flex-col items-stretch gap-1.5">
      {target === null ? null : <TradeOnIbkrButton target={target} />}
      <HoldingActions row={row} link={link} onRevalued={onRevalued} />
    </div>
  );
}
