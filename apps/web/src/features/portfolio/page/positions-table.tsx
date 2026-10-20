import type { CurrencyBreakdown, PortfolioTotals, PositionView } from "@core/portfolio-view.ts";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "@/components/data-state/data-state";
import { ValuationTag } from "@/components/status/valuation-tag";
import { formatAmount, MoneyText } from "../money-text";
import { priceFacts, signedAmount, TickerCell, TradeCell, tone } from "./holding-extras";
import type { HoldingLink } from "./holdings-api";
import { FactList, InfoBox } from "./info-box";
import { PhoneHoldingCard } from "./phone-holding-card";
import {
  DEFAULT_SORT,
  SORT_LABELS,
  type SortDir,
  type SortKey,
  type SortState,
  sortPositions,
} from "./sort";
import { SummaryCard, SummaryTableRow } from "./summary-row";

const qty = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });
const COLUMNS: SortKey[] = ["ticker", "price", "quantity", "value", "unrealized", "tag"];
const HEAD: Partial<Record<SortKey, string>> = {
  ticker: "Ticker",
  price: "Price",
  quantity: "Qty",
  value: "Value",
  unrealized: "P&L",
  tag: "Valuation",
};
const NUMERIC: ReadonlySet<SortKey> = new Set(["price", "quantity", "value", "unrealized"]);
const NUM_CELL = "whitespace-nowrap px-3 py-3.5 text-right align-top tabular-nums";
const GENERAL = {
  price: (where: "table" | "phone") => (
    <p>{`The latest delayed quote from Yahoo (15 minutes or more delayed, not an IBKR price). Without one, it is the closing price of your last IBKR statement. ${where === "table" ? "The ⓘ in a price cell" : "Each card's Details"} shows that line's source and time.`}</p>
  ),
  value: (base: string) => (
    <p>{`Quantity × price × multiplier, calculated by this app, converted to ${base} at the current Yahoo rate (the statement rate where a line says so).`}</p>
  ),
  unrealized: (
    <p>
      Unrealized P&L is value minus cost basis, calculated by this app at delayed prices; IBKR's own
      FIFO figure at the statement close, and whether the two reconcile, is in the ⓘ of each price
      cell. The line beneath it is today's change, estimated from the delayed quote.
    </p>
  ),
  valuation: (
    <p>
      Discounted = at or below its −3 line, Premium = above its +1 line, Extra premium = above +2, a
      dash = inside the channel, Not screened = not a company in the list.
    </p>
  ),
};

/** What a row's price, value and unrealized figures rest on: the facts that used to be grey small print under the numbers. */
function RowFacts({ row, base }: { row: PositionView; base: string }) {
  return (
    <>
      <p className="text-sm font-semibold">{`Price · ${row.ticker}`}</p>
      <FactList facts={priceFacts(row, base)} />
    </>
  );
}

function PriceCell({ row, base }: { row: PositionView; base: string }) {
  const s = row.price.source;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {row.price.value === null ? (
        <MoneyText
          money={{
            kind: "unavailable",
            reason: s.kind === "unavailable" ? s.reason : "price unavailable",
          }}
        />
      ) : (
        <span className="whitespace-nowrap tabular-nums">{`${formatAmount(row.price.value)} ${row.price.ccy}`}</span>
      )}
      <InfoBox
        label={`Price details for ${row.ticker}`}
        active={row.reconciles === false}
        className="w-[340px]"
      >
        <RowFacts row={row} base={base} />
      </InfoBox>
    </span>
  );
}

function ValueCell({ row }: { row: PositionView }) {
  return <MoneyText money={row.marketValue} />;
}

/** Unrealized on top, today's change beneath in 12px. */
function PnlCell({ row }: { row: PositionView }) {
  const unrealized = row.unrealizedIndependent;
  const daily = row.dailyPnl;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <MoneyText
        money={unrealized}
        signed
        className={unrealized.kind === "ok" ? tone(unrealized.value) : ""}
      />
      {daily.kind === "ok" ? (
        <span className={`whitespace-nowrap text-xs ${tone(daily.value)}`}>
          {`${signedAmount(daily.value, daily.ccy)} today`}
        </span>
      ) : (
        <MoneyText money={daily} className="text-xs" />
      )}
      {row.reconciles === false ? (
        <small className="rounded border px-1 text-xs">Does not reconcile</small>
      ) : null}
    </div>
  );
}

function TagCell({ row, notScreened }: { row: PositionView; notScreened: boolean }) {
  if (notScreened)
    return (
      <span className="status-tag" data-tone="grey" data-testid="valuation-not-screened">
        <span>Not screened</span>
      </span>
    );
  return row.tag === "none" ? (
    <>
      <span aria-hidden="true">{"—"}</span>
      <span className="sr-only">within channel</span>
    </>
  ) : (
    <ValuationTag kind={row.tag} />
  );
}

/** "High first" / "Low first" for numbers, "A to Z" / "Z to A" for ticker and valuation. */
function directionLabel(key: SortKey, dir: SortDir): string {
  if (NUMERIC.has(key)) return dir === "desc" ? "High first" : "Low first";
  return dir === "asc" ? "A to Z" : "Z to A";
}

/** The four column explanations, under short titles, for the phone's one "About these numbers" box. */
function AboutNumbers({ base }: { base: string }) {
  const parts: Array<readonly [string, ReactNode]> = [
    ["Price", GENERAL.price("phone")],
    ["Value", GENERAL.value(base)],
    ["P&L", GENERAL.unrealized],
    ["Valuation", GENERAL.valuation],
  ];
  return (
    <>
      {parts.map(([title, body]) => (
        <div key={title} className="space-y-0.5">
          <strong className="block text-sm">{title}</strong>
          {body}
        </div>
      ))}
    </>
  );
}

function SortHeader({
  k,
  sort,
  onSort,
  info,
}: {
  k: SortKey;
  sort: SortState;
  onSort(k: SortKey): void;
  /** The column's general explanation, opened by an ⓘ beside the sort button. */
  info?: { label: string; body: ReactNode } | undefined;
}) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`px-3 py-3.5 ${NUMERIC.has(k) ? "text-right" : "text-left"}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          className="inline-flex items-center gap-1 font-medium"
          onClick={() => onSort(k)}
        >
          {HEAD[k]}
          <Icon aria-hidden="true" size={12} />
        </button>
        {info === undefined ? null : <InfoBox label={info.label}>{info.body}</InfoBox>}
      </span>
    </th>
  );
}

export function PositionsTable({
  rows,
  totals,
  perCurrency,
  base,
  links,
  onRevalued,
  reportDate,
}: {
  rows: readonly PositionView[];
  totals: PortfolioTotals;
  perCurrency: readonly CurrencyBreakdown[];
  base: string;
  /** research state and trade targets by conid; absent while loading or when unavailable */
  links?: ReadonlyMap<number, HoldingLink> | undefined;
  /** called after a successful re-evaluation so the holdings are fetched again */
  onRevalued?: (() => void) | undefined;
  /** the statement date, shown on the Trade dialog's position card */
  reportDate?: string | null | undefined;
}) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const sorted = useMemo(() => sortPositions(rows, sort.key, sort.dir), [rows, sort]);
  if (rows.length === 0)
    return (
      <EmptyState
        title="No open positions in the latest statement."
        description="Positions appear after the next statement day."
      />
    );
  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  const dir: SortDir = sort.dir;
  const infos: Partial<Record<SortKey, { label: string; body: ReactNode }>> = {
    price: { label: "About the price", body: GENERAL.price("table") },
    value: { label: "About the value", body: GENERAL.value(base) },
    unrealized: { label: "About unrealized and daily P&L", body: GENERAL.unrealized },
    tag: { label: "About the valuation tag", body: GENERAL.valuation },
  };
  const notScreened = (conid: number) =>
    links !== undefined && (links.get(conid)?.securityId ?? null) === null;

  return (
    <div className="space-y-4">
      <div className="md:hidden">
        <SummaryCard totals={totals} perCurrency={perCurrency} base={base} />
      </div>

      <table data-testid="positions-table" className="hidden w-full table-fixed text-sm md:table">
        <caption className="sr-only">
          {`Open positions with valuation, sorted by ${SORT_LABELS[sort.key]}.`}
        </caption>
        <colgroup>
          {COLUMNS.map((k) => (
            <col key={k} className="w-[15%]" />
          ))}
          <col className="w-[10%]" />
        </colgroup>
        <thead className="sticky top-0 bg-background">
          <tr>
            {COLUMNS.map((k) => (
              <SortHeader key={k} k={k} sort={sort} onSort={onSort} info={infos[k]} />
            ))}
            <th scope="col" className="px-3 py-3.5 text-right font-medium">
              Trade
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} data-testid={`row-${r.ticker}`} className="border-t">
              <td className="whitespace-nowrap px-3 py-3.5 align-top">
                <TickerCell row={r} link={links?.get(r.conid)} />
              </td>
              <td className={NUM_CELL}>
                <PriceCell row={r} base={base} />
              </td>
              <td className={NUM_CELL}>{qty.format(r.quantity)}</td>
              <td className={NUM_CELL}>
                <ValueCell row={r} />
              </td>
              <td className={NUM_CELL}>
                <PnlCell row={r} />
              </td>
              <td className="whitespace-nowrap px-3 py-3.5 align-top">
                <TagCell row={r} notScreened={notScreened(r.conid)} />
              </td>
              <td className="px-3 py-3.5 text-right align-top">
                <TradeCell
                  row={r}
                  link={links?.get(r.conid)}
                  links={links}
                  onRevalued={onRevalued}
                  reportDate={reportDate}
                />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <SummaryTableRow totals={totals} base={base} />
        </tfoot>
      </table>

      <div data-testid="positions-cards" className="space-y-3 md:hidden">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Sort
            <select
              className="min-h-11 rounded-lg border bg-background px-3 text-sm text-foreground"
              value={sort.key}
              onChange={(e) => setSort({ key: e.target.value as SortKey, dir: "asc" })}
            >
              {COLUMNS.map((k) => (
                <option key={k} value={k}>
                  {HEAD[k]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border bg-background px-3 text-sm"
            onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
          >
            {dir === "asc" ? (
              <ArrowUp aria-hidden="true" size={14} />
            ) : (
              <ArrowDown aria-hidden="true" size={14} />
            )}
            {directionLabel(sort.key, dir)}
          </button>
          <span className="flex-1" />
          <InfoBox label="About these numbers" className="w-[340px] max-w-[calc(100vw-2rem)]">
            <AboutNumbers base={base} />
          </InfoBox>
        </div>
        <ul className="space-y-3">
          {sorted.map((r) => (
            <PhoneHoldingCard
              key={r.id}
              row={r}
              link={links?.get(r.conid)}
              links={links}
              notScreened={notScreened(r.conid)}
              onRevalued={onRevalued}
              reportDate={reportDate}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
