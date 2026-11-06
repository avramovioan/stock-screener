// ESMA register lookups: is an ISIN admitted on a regulated-market segment of an exchange? Pure.
import type { EuExchange } from "./eu-exchanges.ts";

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Trim and uppercase; does not validate. */
export function normalizeIsin(s: string): string {
  return s.trim().toUpperCase();
}

/** ISIN shape plus the Luhn check digit (letters expand to 10..35). */
export function isValidIsin(s: string): boolean {
  if (!ISIN_SHAPE.test(s)) return false;
  let digits = "";
  for (const ch of s) digits += ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const ESMA_SEARCH_URL =
  "https://registers.esma.europa.eu/publication/searchRegister/doMainSearch";

export const ESMA_MANUAL_URLS = {
  venues: "https://registers.esma.europa.eu/publication/searchRegister?core=esma_registers_upreg",
  instruments:
    "https://registers.esma.europa.eu/publication/searchRegister?core=esma_registers_firds",
} as const;

export interface EsmaDoc {
  [field: string]: unknown;
}

const textCriterion = (name: string, value: string) => ({
  name,
  value,
  type: "text",
  isParent: true,
});

/** Venues register (upreg) query by operator LEI. */
export function venuesQueryByLei(lei: string): Record<string, unknown> {
  return {
    core: "esma_registers_upreg",
    pagingSize: "100",
    start: 0,
    keyword: "",
    sortField: "ae_lastUpdate asc",
    criteria: [textCriterion("ae_lei", lei)],
    wt: "json",
  };
}

/** Venues register (upreg) query by MIC (fallback when an exchange has no LEI). */
export function venuesQueryByMic(mic: string): Record<string, unknown> {
  return {
    core: "esma_registers_upreg",
    pagingSize: "100",
    start: 0,
    keyword: "",
    sortField: "ae_lastUpdate asc",
    criteria: [textCriterion("ae_micLeiEsmaId", mic)],
    wt: "json",
  };
}

/** Instruments register (FIRDS) query for one ISIN on one segment MIC, latest publication only. */
export function firdsQuery(isin: string, mic: string): Record<string, unknown> {
  return {
    core: "esma_registers_firds",
    pagingSize: "10",
    start: 0,
    keyword: "",
    sortField: "isin asc",
    criteria: [
      textCriterion("isin", isin),
      textCriterion("mic", mic),
      {
        name: "firdsPublicationDateCustomSearchInputField",
        value: "(latest_received_flag:1)",
        type: "customSearchInputFieldQuery",
        isParent: true,
      },
    ],
    wt: "json",
  };
}

export interface RegulatedSegment {
  mic: string;
  name: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Segments of `exchange` that ESMA lists as an active "Regulated market". The search is a substring
 * match, so only exact MICs of the exchange count. Main (on-book) segments come before "Off-Book" ones.
 */
export function pickRegulatedSegments(
  docs: readonly EsmaDoc[],
  exchange: Pick<EuExchange, "segments">,
): RegulatedSegment[] {
  const seen = new Set<string>();
  const out: RegulatedSegment[] = [];
  for (const doc of docs) {
    const mic = str(doc.ae_micLeiEsmaId);
    if (!exchange.segments.includes(mic) || seen.has(mic)) continue;
    if (str(doc.ae_entityTypeLabel) !== "Regulated market") continue;
    const status = str(doc.ae_status);
    if (status !== "" && status !== "Active") continue;
    seen.add(mic);
    out.push({ mic, name: str(doc.ae_entityName) });
  }
  const offBook = (s: RegulatedSegment) => /off-book/i.test(s.name);
  return [...out.filter((s) => !offBook(s)), ...out.filter(offBook)];
}

/** True when the venues docs contain any exact segment MIC of the exchange (any entity type). */
export function hasExchangeSegment(
  docs: readonly EsmaDoc[],
  exchange: Pick<EuExchange, "segments">,
): boolean {
  return docs.some((d) => exchange.segments.includes(str(d.ae_micLeiEsmaId)));
}

/** The FIRDS doc for exactly this ISIN on exactly this segment MIC, if any. */
export function firdsHasMatch(
  docs: readonly EsmaDoc[],
  isin: string,
  mic: string,
): EsmaDoc | undefined {
  return docs.find((d) => d.isin === isin && d.mic === mic);
}

export const ESMA_SOLR_BASE = "https://registers.esma.europa.eu/solr";

const SOLR_VALUE = /^[A-Z0-9]+$/;

/** A value that may be put into a Solr q string: upper-case letters and digits only, otherwise throws. */
export function solrValue(v: string): string {
  if (!SOLR_VALUE.test(v)) throw new Error("invalid Solr value");
  return v;
}

const solrUrl = (core: string, q: string, rows: number, fl: string): string =>
  `${ESMA_SOLR_BASE}/${core}/select?q=${encodeURIComponent(q)}&wt=json&rows=${rows}&fl=${encodeURIComponent(fl)}`;

/** Exact-field Solr q for the FIRDS core: one ISIN on any of the given segment MICs, latest publication. */
export function firdsSolrQ(isin: string, mics: readonly string[]): string {
  if (mics.length === 0) throw new Error("no MICs");
  return `isin:${solrValue(isin)} AND latest_received_flag:1 AND mic:(${mics.map(solrValue).join(" OR ")})`;
}

/** FIRDS select URL for one ISIN across several segment MICs (a single exact-field request). */
export function firdsSolrUrl(isin: string, mics: readonly string[]): string {
  return solrUrl(
    "esma_registers_firds",
    firdsSolrQ(isin, mics),
    50,
    "isin,mic,gnr_full_name,mrkt_trdng_start_date",
  );
}

const UPREG_FIELDS = "ae_micLeiEsmaId,ae_entityName,ae_entityTypeLabel,ae_status";

/** Venues register select URL by operator LEI. */
export function venuesSolrUrlByLei(lei: string): string {
  return solrUrl("esma_registers_upreg", `ae_lei:${solrValue(lei)}`, 100, UPREG_FIELDS);
}

/** Venues register select URL by MIC (fallback when an exchange has no LEI). */
export function venuesSolrUrlByMic(mic: string): string {
  return solrUrl("esma_registers_upreg", `ae_micLeiEsmaId:${solrValue(mic)}`, 100, UPREG_FIELDS);
}

/** `response.docs` of a Solr/doMainSearch JSON body; null for HTML, malformed JSON or another shape. */
export function parseEsmaDocs(text: string): EsmaDoc[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const docs = (parsed as { response?: { docs?: unknown } } | null)?.response?.docs;
  if (!Array.isArray(docs)) return null;
  return docs.filter((d): d is EsmaDoc => typeof d === "object" && d !== null);
}

/** First regulated segment, in try order, that has an exact isin+mic doc in `docs`. */
export function firstFirdsMatch(
  docs: readonly EsmaDoc[],
  isin: string,
  segments: readonly RegulatedSegment[],
): { segment: RegulatedSegment; doc: EsmaDoc } | undefined {
  for (const segment of segments) {
    const doc = firdsHasMatch(docs, isin, segment.mic);
    if (doc) return { segment, doc };
  }
  return undefined;
}
