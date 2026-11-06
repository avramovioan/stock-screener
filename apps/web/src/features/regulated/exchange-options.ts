import type { EuExchange } from "@core/eu-exchanges.ts";

export interface ExchangeGroup {
  country: string;
  countryName: string;
  exchanges: EuExchange[];
}

/** Lower-cases and strips diacritics so "Börse" matches "borse". */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Exchanges matching the query: MIC prefix first, then MIC contains, then name contains
 * (case- and diacritic-insensitive), each tier in MIC order. An empty query matches all.
 */
export function filterExchanges(exchanges: readonly EuExchange[], query: string): EuExchange[] {
  const q = fold(query.trim());
  const byMic = (a: EuExchange, b: EuExchange) => a.mic.localeCompare(b.mic);
  if (q === "") return [...exchanges].sort(byMic);
  const prefix: EuExchange[] = [];
  const contains: EuExchange[] = [];
  const named: EuExchange[] = [];
  for (const ex of exchanges) {
    const mic = ex.mic.toLowerCase();
    if (mic.startsWith(q)) prefix.push(ex);
    else if (mic.includes(q)) contains.push(ex);
    else if (fold(ex.name).includes(q)) named.push(ex);
  }
  return [...prefix.sort(byMic), ...contains.sort(byMic), ...named.sort(byMic)];
}

/** Filtered exchanges in sections by country (ordered by English country name); relevance order kept inside a section. */
export function groupExchanges(exchanges: readonly EuExchange[], query: string): ExchangeGroup[] {
  const groups = new Map<string, ExchangeGroup>();
  for (const ex of filterExchanges(exchanges, query)) {
    const group = groups.get(ex.country);
    if (group) group.exchanges.push(ex);
    else {
      groups.set(ex.country, {
        country: ex.country,
        countryName: countryName(ex.country),
        exchanges: [ex],
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.countryName.localeCompare(b.countryName, "en"));
}
