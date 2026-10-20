import { formatPrice, formatSessionDate, homeTicker } from "@/lib/format";

const US = "United States";

/** What the evaluation prompt needs about a company: a Today's discounts card and a held line both supply it. */
export interface ResearchPromptInput {
  name: string;
  yahoo_symbol: string;
  exchange_code: string | null;
  exchange_name: string;
  country: string | null;
  listing_country?: string | null | undefined;
  /** The last price; null when it is not known (a held line without a quote or statement price). */
  close: number | null;
  currency: string;
  session_date: string;
  /** The −3 and −4 line levels at that close; null when they are not known (a held line without a screen row). */
  line3_end: number | null;
  line4_end: number | null;
}

function sources(row: ResearchPromptInput): string {
  const edgar = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(row.name)}`;
  const company =
    row.listing_country === US
      ? `- SEC EDGAR company search: ${edgar}\n  Read the latest 10-K, 10-Q and 8-K filings.`
      : "- The company's investor relations site: the latest annual and interim reports, earnings releases and announcements.";
  return `${company}\n- News of the last 90 days about the fall in the share price, from credible independent reporting.`;
}

/**
 * The self-contained evaluation prompt of a card (spec 5.2), in English, for any chat assistant. The wording of the role
 * line and the two questions follows the pipeline's research prompt.
 */
export function buildResearchPrompt(row: ResearchPromptInput): string {
  const ticker = homeTicker(row.yahoo_symbol, row.exchange_code, row.listing_country);
  const money = (value: number) => formatPrice(value, row.currency);
  return [
    "My strategy identifies stocks whose prices have fallen substantially below their historical trend. I assess the technical entry separately. Your job is to investigate the business objectively and answer two questions:",
    "",
    "1. Is the stock falling for temporary reasons, or because of lasting damage to the business?",
    "2. Is the company at risk of bankruptcy, or financially strong enough to survive its current problems?",
    "",
    "The company:",
    `- Name: ${row.name}`,
    `- Ticker: ${ticker} (Yahoo ${row.yahoo_symbol})`,
    `- Exchange: ${row.exchange_name}`,
    `- Country: ${row.country ?? "unknown"}`,
    row.close === null
      ? "- Last close: not available for this holding"
      : `- Last close: ${money(row.close)} on ${formatSessionDate(row.session_date)}`,
    row.line3_end === null || row.line4_end === null
      ? "- Channel lines at that close: The −3/−4 line levels are not available for this holding"
      : `- Channel lines at that close: the −3 line is at ${money(row.line3_end)} and the −4 line at ${money(row.line4_end)}`,
    "",
    "Use current web research. Read the latest available annual report and quarterly or interim report, including relevant financial-statement notes. Check later earnings releases, material announcements, and reliable reporting about the reasons for the decline. Treat management's expectations as claims to evaluate. Use measures appropriate to the industry.",
    "",
    "Sources to start from:",
    sources(row),
    "",
    "Output:",
    "- A short conclusion: does the company meet these two fundamental checks, not meet one or both, or is the evidence insufficient to decide.",
    "- Bankruptcy risk: Low, Moderate, High or Unclear, as a qualitative judgment with the reasons.",
    "- The facts with their sources, kept apart from what management claims.",
    "- Any limitations: documents you could not find or read.",
    "",
    "Write for a beginner and keep it to about 500 to 800 words, with the sources listed separately. Leave technical-analysis commentary out.",
  ].join("\n");
}
