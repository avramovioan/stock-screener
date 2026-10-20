import type { CompanyListRow } from "./types";

export const PAGE_FIRST = 15;
export const PAGE_NEXT = 25;

/** Flatten infinite-query pages into one list: unique by rank (first wins), ascending rank. */
export function pageMerge(pages: readonly (readonly CompanyListRow[])[]): CompanyListRow[] {
  const byRank = new Map<number, CompanyListRow>();
  for (const page of pages) {
    for (const r of page) if (!byRank.has(r.rank)) byRank.set(r.rank, r);
  }
  return [...byRank.values()].sort((a, b) => a.rank - b.rank);
}

/**
 * Keyset cursor for the next page, or undefined when the list is exhausted.
 * `total_count` of a page is the number of rows after that page's cursor (spec 6.6.4),
 * so rows remain while `total_count > page length`.
 */
export function nextAfterRank(lastPage: readonly CompanyListRow[]): number | undefined {
  const first = lastPage[0];
  const last = lastPage[lastPage.length - 1];
  if (!first || !last) return undefined;
  return Number(first.total_count) > lastPage.length ? last.rank : undefined;
}
