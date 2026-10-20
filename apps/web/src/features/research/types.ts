export interface ClaimGroup {
  section:
    | "established_facts"
    | "management_claims"
    | "forecasts"
    | "allegations"
    | "interpretation";
  items: { text: string; evidence_ids: number[] }[];
}

export interface ReportData {
  id: string;
  companyName: string;
  ticker: string;
  researchDate: string;
  cutoffDate: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  conclusion: string | null;
  bankruptcyRisk: string | null;
  materialDamageEstablished: boolean | null;
  sufficientEvidence: boolean | null;
  reportMd: string;
  claims: ClaimGroup[];
  missingDocuments: string[];
  limitations: string[];
  /** URLs of the evidence ledger (research_sources): the only URLs the report body may link to. */
  sourceUrls?: string[];
  /** The evidence ledger (research_sources), ordered by evidence id; ids match the [E#] markers. */
  sources?: ReportSource[];
}

export interface ReportSource {
  evidenceId: number;
  title: string | null;
  publisher: string | null;
  /** ISO date (filing date, else publication date) or null. */
  date: string | null;
  url: string;
}
