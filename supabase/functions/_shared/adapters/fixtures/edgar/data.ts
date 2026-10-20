/** Submissions per CIK: a 10-K, a 10-Q and an 8-K (HOLD's 8-K is the material one). Synthetic fixture data for PROVIDER_MODE=fixture. */
export const SUBMISSIONS: Record<string, unknown> = Object.fromEntries(
  [
    ["0000111111", "grnc", "111111"],
    ["0000222222", "rdco", "222222"],
    ["0000333333", "hold", "333333"],
  ].map(([cik, slug, short]) => [
    cik,
    {
      cik,
      filings: {
        recent: {
          accessionNumber: [`${cik}-26-000003`, `${cik}-26-000002`, `${cik}-26-000001`],
          filingDate: ["2026-10-14", "2026-08-01", "2026-02-20"],
          reportDate: ["2026-10-13", "2026-06-30", "2025-12-31"],
          form: ["8-K", "10-Q", "10-K"],
          primaryDocument: [`${slug}-8k.htm`, `${slug}-10q.htm`, `${slug}-10k.htm`],
          shortCik: [short, short, short],
        },
      },
    },
  ]),
);

export const COMPANY_TICKERS = {
  "0": { cik_str: 111111, ticker: "GRNC", title: "Greenfield Corp" },
  "1": { cik_str: 222222, ticker: "RDCO", title: "Redline Holdings" },
  "2": { cik_str: 333333, ticker: "HOLD", title: "Holdfast Inc" },
};
