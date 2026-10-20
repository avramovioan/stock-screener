import { useNavigate, useSearch } from "@tanstack/react-router";
import { CountryFilterControl } from "@/components/country-filter";
import { countryFilterFromSearch } from "@/features/screening/country-filter";
import { useScanStatus } from "@/features/screening/hooks";
import { useResearchLive } from "@/features/screening/use-research-live";
import { CompanyList } from "./company-list";
import { OverviewHeading } from "./overview-heading";
import { ScanBanner } from "./scan-status-bar";
import { ShortSummarySection } from "./short-summary-section";
import { TodaysDiscounts } from "./todays-discounts";

/** Shown instead of the list while the scan has not reached the publish threshold. */
function ListNotPublished({ coverage }: { coverage: number | undefined }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 sm:p-5">
      <p className="text-[15px] font-medium">Today's list isn't published yet</p>
      <p className="text-sm leading-normal text-muted-foreground">
        {`It appears once at least 95% of companies are evaluated.${
          coverage === undefined ? "" : ` Today's scan reached ${Math.round(coverage * 100)}%.`
        }`}
      </p>
    </div>
  );
}

export function OverviewPage() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const filter = countryFilterFromSearch(search);
  const publish = useScanStatus().data?.latest_published?.coverage?.publish;
  const listPublished = publish?.list !== false;
  useResearchLive();

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="discounts-heading" className="flex flex-col gap-4 sm:gap-5">
        <OverviewHeading filter={filter} />
        <ScanBanner />
        <CountryFilterControl
          value={filter}
          onChange={(next) =>
            void navigate({
              search: (prev) => ({ ...prev, country: next === "us" ? "us" : undefined }),
              replace: true,
            })
          }
          helpText="United States = listed on NYSE or Nasdaq, whatever the company's home country (Aon stays in)."
        />
        <TodaysDiscounts filter={filter} />
      </section>
      <section aria-labelledby="company-list-heading" className="flex flex-col gap-3">
        <h2 id="company-list-heading" className="text-xl font-semibold sm:text-[22px]">
          The Company List
        </h2>
        {listPublished ? (
          <>
            <p className="text-sm text-muted-foreground">
              Worldwide ranking by market capitalization. A close at or below the −3 line is a
              discount.
            </p>
            <ShortSummarySection />
            <CompanyList key={filter} filter={filter} />
          </>
        ) : (
          <ListNotPublished coverage={publish?.list_coverage} />
        )}
      </section>
    </div>
  );
}
