import { useMemo } from "react";
import { type CountryFilter, filterByCountry } from "@/features/screening/country-filter";
import { useTodaysDiscounts } from "@/features/screening/hooks";
import { groupDiscounts } from "./sort-discounts";

/** Today's feed under the country filter, grouped: `all` is the one grid (flagged cards last), `cards` the unflagged part (the heading counts these). */
export function useDiscountGroups(filter: CountryFilter) {
  const query = useTodaysDiscounts();
  const groups = useMemo(
    () => groupDiscounts(filterByCountry(query.data ?? [], filter)),
    [query.data, filter],
  );
  return { query, ...groups };
}
