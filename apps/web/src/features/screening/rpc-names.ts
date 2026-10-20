/** The only place that names database functions (P4-D2). */
export const RPC = {
  scanStatus: "scan_status",
  discountsFeed: "todays_discounts_feed",
  companyList: "company_list",
  shortSummary: "universe_summary",
  priceSeries: "get_price_series",
  researchQuota: "research_quota_status",
} as const;
