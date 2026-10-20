import type { PositionView } from "@core/portfolio-view.ts";
import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ValuationTag } from "@/components/status/valuation-tag";
import { exchangeText } from "@/features/handoff/position-card";
import { decodeXmlEntities } from "@/lib/format";
import { formatAmount, MoneyText } from "../money-text";
import {
  brokerPnl,
  costBasisLine,
  priceSourceLine,
  researchFact,
  screenedLine,
  signedAmount,
  TradeCell,
  tone,
} from "./holding-extras";
import type { HoldingLink } from "./holdings-api";

const shares = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });

function Tag({ row, notScreened }: { row: PositionView; notScreened: boolean }) {
  if (notScreened)
    return (
      <span className="status-tag" data-tone="grey" data-testid="valuation-not-screened">
        <span>Not screened</span>
      </span>
    );
  return row.tag === "none" ? (
    <span className="status-tag" data-tone="grey">
      <span>Within channel</span>
    </span>
  ) : (
    <ValuationTag kind={row.tag} />
  );
}

/** The facts under Details: the ticker box and the price box of the table, merged into one list. */
function detailFacts(row: PositionView, link: HoldingLink | undefined) {
  const held = link?.held;
  const exchange = held?.listingExchange ?? null;
  const isin = link?.isin ?? null;
  const screened = link !== undefined && link.securityId !== null && link.symbol !== null;
  const facts: Array<readonly [string, ReactNode]> = [
    [
      "Held as",
      `${held?.symbol ?? row.ticker}${exchange === null ? "" : ` on ${exchangeText(exchange)}`}, ${held?.currency ?? row.currency}`,
    ],
  ];
  if (isin !== null) facts.push(["ISIN", isin]);
  facts.push([screened ? "Screened as" : "Screened", screenedLine(link)]);
  facts.push([
    "Avg cost",
    row.averageCost === null ? "unavailable" : `${formatAmount(row.averageCost)} ${row.currency}`,
  ]);
  facts.push(["Cost basis", costBasisLine(row)]);
  facts.push(["Price", priceSourceLine(row)]);
  facts.push([
    "IBKR P&L",
    row.unrealizedBroker === null
      ? brokerPnl(row)
      : `${brokerPnl(row)} FIFO at the statement close${row.reconciles === null ? "" : row.reconciles ? " · reconciles" : " · does not reconcile"}`,
  ]);
  if (row.tagBasis !== null) facts.push(["Valuation", row.tagBasis]);
  if (row.price.note !== null) facts.push(["Note", row.price.note]);
  const research = researchFact(row, link);
  if (research !== null) facts.push(research);
  return facts;
}

/** One holding on a phone: the figures that matter, the actions, and a Details row that opens the facts in place. */
export function PhoneHoldingCard({
  row,
  link,
  links,
  notScreened,
  onRevalued,
  reportDate,
}: {
  row: PositionView;
  link: HoldingLink | undefined;
  links: ReadonlyMap<number, HoldingLink> | undefined;
  notScreened: boolean;
  onRevalued?: (() => void) | undefined;
  reportDate?: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const price =
    row.price.value === null
      ? "price unavailable"
      : `${formatAmount(row.price.value)} ${row.price.ccy}`;
  const unrealized = row.unrealizedIndependent;
  const daily = row.dailyPnl;
  const Chevron = open ? ChevronUp : ChevronDown;
  const facts = open ? detailFacts(row, link) : [];
  return (
    <li
      data-testid={`card-${row.ticker}`}
      className="flex flex-col rounded-[14px] border bg-card text-card-foreground"
    >
      <div className="flex flex-col gap-2.5 px-4 pt-3.5 pb-3">
        <div className="flex items-center justify-between gap-2.5">
          <span data-testid="card-ticker" className="text-xl font-semibold tracking-[0.01em]">
            {row.ticker}
          </span>
          <Tag row={row} notScreened={notScreened} />
        </div>
        <p className="-mt-1.5 truncate text-sm text-muted-foreground">
          {decodeXmlEntities(row.name ?? row.ticker)}
        </p>
        <p className="whitespace-nowrap text-sm tabular-nums">{`${shares.format(row.quantity)} ${row.quantity === 1 ? "share" : "shares"} · ${price}`}</p>
        <div className="grid grid-cols-2 gap-2.5 border-t pt-2.5">
          <div>
            <p className="text-xs text-muted-foreground">Value</p>
            <MoneyText money={row.marketValue} className="block text-[17px] font-semibold" />
          </div>
          <div className="flex flex-col items-end">
            <p className="text-xs text-muted-foreground">P&L</p>
            <MoneyText
              money={unrealized}
              signed
              className={`text-[17px] font-semibold ${unrealized.kind === "ok" ? tone(unrealized.value) : ""}`}
            />
            {daily.kind === "ok" ? (
              <span className={`whitespace-nowrap text-[13px] tabular-nums ${tone(daily.value)}`}>
                {`${signedAmount(daily.value, daily.ccy)} today`}
              </span>
            ) : (
              <MoneyText money={daily} className="text-[13px]" />
            )}
            {row.reconciles === false ? (
              <small className="rounded border px-1 text-xs">Does not reconcile</small>
            ) : null}
          </div>
        </div>
        <TradeCell
          row={row}
          link={link}
          links={links}
          onRevalued={onRevalued}
          reportDate={reportDate}
          layout="row"
        />
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center justify-between rounded-b-[14px] border-t px-4 text-sm font-medium text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {open ? "Hide details" : "Details"}
        <Chevron aria-hidden="true" size={18} />
      </button>
      {open ? (
        <dl
          id={panelId}
          className="m-0 grid grid-cols-[6rem_1fr] gap-x-2.5 gap-y-1.5 px-4 pt-1 pb-3.5 text-[13px]"
        >
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="m-0 min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
