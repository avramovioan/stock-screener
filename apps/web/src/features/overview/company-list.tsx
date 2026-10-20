import { CountryFlag } from "@/components/country-flag";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { MovementCell } from "@/components/status/movement-cell";
import { type CountryFilter, countryNameForFilter } from "@/features/screening/country-filter";
import { errorText } from "@/features/screening/errors";
import { useCompanyList } from "@/features/screening/hooks";
import { pageMerge } from "@/features/screening/page-merge";
import type { CompanyListRow } from "@/features/screening/types";
import { formatCompactPrice, formatPrice, formatSessionDate, homeTicker } from "@/lib/format";
import { useIsNarrow } from "./use-is-narrow";

function capText(r: CompanyListRow): string {
  return r.market_cap_native !== null && r.market_cap_ccy
    ? formatCompactPrice(r.market_cap_native, r.market_cap_ccy)
    : formatCompactPrice(r.market_cap_usd, "USD");
}

function tickerOf(r: CompanyListRow): string {
  return homeTicker(r.yahoo_symbol, r.exchange_code, r.listing_country);
}

function priceText(r: CompanyListRow): string {
  const unavailable = r.price_freshness === "unavailable" || r.last_close === null;
  return unavailable ? "n/a" : formatPrice(r.last_close, r.currency);
}

/** The Today column: the movement, or "Stale price" when the close is old (the title names the date). */
function TodayCell({ r }: { r: CompanyListRow }) {
  if (r.price_freshness === "stale") {
    return (
      <span className="text-muted-foreground" title={`Close ${formatSessionDate(r.session_date)}`}>
        Stale price
      </span>
    );
  }
  return <MovementCell pct={r.change_pct} />;
}

function Top10Marker({ r }: { r: CompanyListRow }) {
  return r.is_top10 ? <span className="sr-only">Top 10</span> : null;
}

function CarriedTag({ r }: { r: CompanyListRow }) {
  return r.state === "carried_forward" ? (
    <span className="status-tag ml-2" data-tone="amber">
      Not updated today
    </span>
  ) : null;
}

function CountryCell({ country }: { country: string | null }) {
  return (
    <span className="inline-flex items-center gap-2">
      <CountryFlag country={country} />
      {country ?? "Unknown"}
    </span>
  );
}

function Table({ rows }: { rows: CompanyListRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Companies ranked by market capitalization</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="w-[72px] px-4 py-3 font-medium">
                Rank
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Company
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Country
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Price
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Today
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Market cap
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.rank}
                data-testid="company-row"
                className={`border-b last:border-b-0 ${r.is_top10 ? "row-top10" : ""}`}
                {...(r.is_top10 ? { "aria-description": "Top 10" } : {})}
              >
                <th scope="row" className="px-4 py-3 text-left font-medium tabular-nums">
                  <span>{`#${r.rank}`}</span>
                  <Top10Marker r={r} />
                </th>
                <td className="px-4 py-3">
                  <span className="font-medium" title={r.name}>
                    {r.name}
                  </span>{" "}
                  <span className="text-muted-foreground">{tickerOf(r)}</span>
                  <CarriedTag r={r} />
                </td>
                <td className="px-4 py-3">
                  <CountryCell country={r.country} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{priceText(r)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <TodayCell r={r} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{capText(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cards({ rows }: { rows: CompanyListRow[] }) {
  return (
    <ol className="m-0 list-none overflow-hidden rounded-xl border bg-card p-0">
      {rows.map((r) => (
        <li
          key={r.rank}
          data-testid="company-card"
          className={`grid grid-cols-[40px_1fr_auto] gap-x-3 gap-y-1 border-b px-3.5 py-3 last:border-b-0 ${r.is_top10 ? "row-top10" : ""}`}
          {...(r.is_top10 ? { "aria-description": "Top 10" } : {})}
        >
          <span className="font-medium tabular-nums">
            {`#${r.rank}`}
            <Top10Marker r={r} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-medium" title={r.name}>
              {r.name}
              <CarriedTag r={r} />
            </span>
            <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <CountryFlag country={r.country} />
              {`${r.country ?? "Unknown"}, ${tickerOf(r)}`}
            </span>
          </div>
          <div className="flex flex-col gap-1 text-right tabular-nums">
            <span className="font-medium">{priceText(r)}</span>
            <span className="text-[13px]">
              <TodayCell r={r} />
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The ranked list under the country filter. The database applies the filter (`company_list` p_country), so the first page is
 * 15 matching rows and "Load more" fetches the next 25 by rank. The parent keys this component by the filter.
 */
export function CompanyList({ filter }: { filter: CountryFilter }) {
  const q = useCompanyList(countryNameForFilter(filter));
  const narrow = useIsNarrow();
  const rows = pageMerge(q.data?.pages ?? []);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  return (
    <div className="space-y-3">
      {q.isLoading ? <Loading label="Loading the company list" rows={6} /> : null}
      {q.isError ? (
        <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />
      ) : null}
      {q.data && rows.length === 0 ? (
        <EmptyState
          title="No companies in this list yet"
          description={
            filter === "us"
              ? "No United States company is in the list yet. Choose All exchanges to see the whole list."
              : "The list appears after the first published scan."
          }
        />
      ) : null}
      {rows.length > 0 ? narrow ? <Cards rows={rows} /> : <Table rows={rows} /> : null}
      {hasNextPage && rows.length > 0 ? (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="min-h-11 rounded-lg border border-input bg-card px-[18px] text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {isFetchingNextPage ? "Loading..." : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
