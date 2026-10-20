export type CountryFilter = "all" | "us";

/** The exchange country the "Listed in" US filter matches (`exchanges.country`). */
export const US_COUNTRY = "United States";

/** The country name the database filters on: null for every country. */
export function countryNameForFilter(filter: CountryFilter): string | null {
  return filter === "us" ? US_COUNTRY : null;
}

export function matchesCountry(country: string | null | undefined, filter: CountryFilter): boolean {
  return filter === "all" || country === US_COUNTRY;
}

export function filterByCountry<T extends { listing_country: string | null }>(
  rows: readonly T[],
  filter: CountryFilter,
): T[] {
  return rows.filter((r) => matchesCountry(r.listing_country, filter));
}

/** `?country=us` maps to the US filter; anything else (absent, invalid) is all countries. */
export function countryFilterFromSearch(search: { country?: "us" | undefined }): CountryFilter {
  return search.country === "us" ? "us" : "all";
}
