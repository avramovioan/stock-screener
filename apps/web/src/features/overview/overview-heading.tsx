import { Link } from "@tanstack/react-router";
import { Skeleton } from "@/components/data-state/data-state";
import type { CountryFilter } from "@/features/screening/country-filter";
import { useScanStatus } from "@/features/screening/hooks";
import { ScanStatusBar } from "./scan-status-bar";
import { useDiscountGroups } from "./use-discount-groups";

/**
 * "3 companies closed at or below their \u22123 line, 1 of them at its \u22124 line." (counts follow the country filter).
 * The ", k of them" clause drops at zero.
 */
export function overviewSentence(filter: CountryFilter, count: number, atLine4 = 0): string {
  const noun = filter === "us" ? "US " : "";
  if (count === 0) return `No ${noun}companies closed at or below their −3 line today.`;
  if (count === 1) {
    return `1 ${noun}company closed at or below its −3 line${atLine4 > 0 ? ", at its −4 line." : "."}`;
  }
  const head = `${count} ${noun}companies closed at or below their −3 line`;
  if (atLine4 === 0) return `${head}.`;
  return `${head}, ${atLine4} of them at ${atLine4 === 1 ? "its" : "their"} −4 line.`;
}

/** "451 of 640 companies worth US$50B or more were evaluated." */
export function evaluatedSentence(processed: number, total: number): string {
  return `${processed} of ${total} companies worth US$50B or more were evaluated.`;
}

export function OverviewHeading({ filter }: { filter: CountryFilter }) {
  const { query, cards } = useDiscountGroups(filter);
  const candidates = useScanStatus().data?.latest_published?.coverage?.candidates;
  return (
    <div className="flex flex-col-reverse gap-1.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-6 sm:gap-y-2">
      <div className="flex flex-col gap-1.5">
        <h1
          id="discounts-heading"
          className="text-[28px] font-semibold leading-tight tracking-[-0.01em] sm:text-[32px]"
        >
          Today's discounts
        </h1>
        {query.data ? (
          <p className="text-[15px] leading-snug text-muted-foreground">
            {overviewSentence(
              filter,
              cards.length,
              cards.filter((card) => card.reached_line4).length,
            )}
            {candidates ? ` ${evaluatedSentence(candidates.processed, candidates.total)}` : ""}{" "}
            <Link to="/how-it-works" className="text-primary underline underline-offset-[3px]">
              How it works
            </Link>
          </p>
        ) : (
          <Skeleton className="h-5 w-72 max-w-full" />
        )}
      </div>
      <ScanStatusBar />
    </div>
  );
}
