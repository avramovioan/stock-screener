import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import type { CountryFilter } from "@/features/screening/country-filter";
import { errorText } from "@/features/screening/errors";
import { useQuotes } from "@/features/screening/quotes-hooks";
import type { DiscountRow } from "@/features/screening/types";
import { DiscountCard } from "./discount-card";
import { useDiscountGroups } from "./use-discount-groups";

const GRID = "grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))]";

/** The one card grid: cleared, caution, pending, then the flagged cards last. */
export function TodaysDiscounts({ filter }: { filter: CountryFilter }) {
  const { query: q, all } = useDiscountGroups(filter);
  const eurSymbols = all.flatMap((c: DiscountRow) =>
    c.eur_status === "verified" && c.eur_symbol_yahoo ? [c.eur_symbol_yahoo] : [],
  );
  const quotes = useQuotes(eurSymbols);
  const bySymbol = new Map((quotes.data ?? []).map((x) => [x.symbol, x]));
  const quoteFor = (row: DiscountRow) =>
    row.eur_symbol_yahoo ? bySymbol.get(row.eur_symbol_yahoo) : undefined;

  return (
    <>
      {q.isLoading ? <Loading label="Loading today's discounts" rows={4} /> : null}
      {q.isError ? (
        <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />
      ) : null}
      {q.data && all.length === 0 ? (
        <EmptyState
          title="No discounts today"
          description={`No ${filter === "us" ? "United States " : ""}candidate met the technical rule in the latest scan.`}
        />
      ) : null}
      {all.length > 0 ? (
        <div className={GRID}>
          {all.map((row) => (
            <DiscountCard
              key={`${row.mode}-${row.security_id}`}
              row={row}
              eurQuote={quoteFor(row)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
