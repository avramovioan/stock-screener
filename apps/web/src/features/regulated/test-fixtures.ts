import type { EuExchange } from "@core/eu-exchanges.ts";

/** Small stand-in for the real exchange list, so tests do not depend on its contents. */
export const FIXTURE_EXCHANGES: readonly EuExchange[] = [
  { mic: "XETR", name: "Deutsche Börse Xetra", country: "DE", segments: ["XETA"], leis: [] },
  { mic: "XFRA", name: "Frankfurter Wertpapierbörse", country: "DE", segments: ["XFRA"], leis: [] },
  { mic: "XETB", name: "Xetra Blue Test", country: "AT", segments: [], leis: [] },
  { mic: "XPAR", name: "Euronext Paris", country: "FR", segments: ["XPAR"], leis: [] },
  { mic: "XWBO", name: "Wiener Börse", country: "AT", segments: ["XWBO"], leis: [] },
  { mic: "XAMS", name: "Euronext Amsterdam", country: "NL", segments: ["XAMS"], leis: [] },
];

export const VALID_ISIN = "IE00BMFKG444";
