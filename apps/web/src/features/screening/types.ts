/** The feed's `mode` column: the ranking a row belongs to. The web reads `worldwide` only. */
export type FeedMode = "worldwide" | "us";
export type OperationalCategory = "green" | "amber" | "red" | "grey" | "pending";
export type Freshness = "fresh" | "stale" | "unavailable";
export type ScanRunStatus = "queued" | "running" | "partial" | "complete" | "failed";

/** `scan_runs.coverage` (spec 7.7); every group optional because partial runs may omit groups. */
export interface Coverage {
  universe?: { exchanges_total: number; exchanges_ok: number; failed_exchanges: string[] };
  candidates?: {
    total: number;
    processed: number;
    skipped?: number;
    failed?: number;
    insufficient_data?: number;
    stale?: number;
    unprocessed?: number;
    carried_forward?: number;
  };
  prices?: { fresh: number; stale: number; unavailable: number; suspect?: number };
  research?: {
    required: number;
    complete: number;
    pending: number;
    quota_deferred: number;
    failed: number;
  };
  publish?: { results: boolean; list: boolean; list_coverage: number };
}

/** `public.scan_status()` (spec 6.6.4). The three timestamps are never merged. */
export interface ScanStatus {
  last_attempted: { scan_date_local: string; started_at: string; status: ScanRunStatus } | null;
  last_successful: { scan_date_local: string; finished_at: string } | null;
  latest_published: {
    scan_date_local: string;
    status: ScanRunStatus;
    latest_session_date: string | null;
    coverage: Coverage | null;
    results_published_at: string | null;
    list_published_at: string | null;
  } | null;
  /** The latest skipped scan (no new market close). Absent on older deployments. */
  last_skipped?: {
    scan_date_local: string;
    at: string;
    reason: string;
    scope: string;
  } | null;
}

/** One row of `public.todays_discounts_feed(p_mode)` (view `v_todays_discounts`). */
export interface DiscountRow {
  scan_run_id: string;
  mode: FeedMode;
  rank: number;
  display_order: number;
  withheld: boolean;
  security_id: string;
  yahoo_symbol: string;
  name: string;
  exchange_code: string;
  exchange_name: string;
  close: number;
  currency: string;
  session_date: string;
  threshold_line: "-3" | "-4" | "+1" | "+2";
  lower_line_end: number;
  /** The -3 and -4 lower lines at the latest bar. */
  line3_end: number;
  line4_end: number;
  /** close <= line4_end. */
  reached_line4: boolean;
  /** Worldwide rank 1-10 at the scan: the only rows that may carry "Strong buy". */
  is_top10: boolean;
  data_freshness: Freshness;
  is_new_episode: boolean;
  since_date: string | null;
  operational_category: OperationalCategory;
  category_reason: string;
  conclusion: string | null;
  bankruptcy_risk: "Low" | "Moderate" | "High" | "Unclear" | null;
  summary: string | null;
  research_completed_at: string | null;
  report_id: string | null;
  eur_symbol_yahoo: string | null;
  ibkr_local_symbol: string | null;
  ibkr_exchange_id: string | null;
  eur_status: "verified" | "unverified" | "none" | null;
  eur_verified_at: string | null;
  /** Provenance of the completed report (the model that wrote it) and why a backup wrote it. */
  research_provider: string | null;
  research_model: string | null;
  fallback_reason: "primary_unavailable" | "primary_quota" | "primary_rate_limited" | null;
  /** True when the backup model wrote the report from a shorter evidence set (its request budget cut the evidence). */
  evidence_trimmed: boolean | null;
  /** Why research is waiting, with the times and the next model id (not a provider id). */
  wait_reason:
    | "provider_unavailable"
    | "llm_quota"
    | "search_quota"
    | "rate_limited"
    | "weekend"
    | "cadence_72h"
    | null;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  next_provider: string | null;
  /** Company country (Yahoo assetProfile, exchange country as the fallback); null when unknown. */
  country: string | null;
  /** Country of the exchange the row is listed on (the "Listed in" filter reads this, not `country`). */
  listing_country: string | null;
  /** The in-flight research report's start time; null when none is queued, running or deferred. */
  research_started_at: string | null;
  /** Why the in-flight report is waiting (`rate_limited`, `provider_unavailable`, `llm_quota`, `search_quota`). */
  research_wait_reason: string | null;
  /** Who asked for the in-flight report. */
  research_requested_by: "visitor" | "owner" | "system" | null;
  /** When the newest failed report failed (the retry rule starts from here). */
  research_failed_at: string | null;
  /** Why the newest failed report failed (`providers_busy`, `no_quota`, other codes); null when none failed. */
  research_failed_reason: string | null;
}

/** `public.research_quota_status()`: whether a new AI scan can run now, and when the earliest block clears. */
export interface ResearchQuotaStatus {
  available: boolean;
  next_reset_at: string | null;
}

/** One row of `public.company_list(p_mode, p_limit, p_after_rank)`. */
export interface CompanyListRow {
  rank: number;
  company_id: string;
  security_id: string;
  yahoo_symbol: string;
  name: string;
  currency: string;
  last_close: number | null;
  prev_close: number | null;
  change_pct: number | null;
  session_date: string | null;
  price_freshness: Freshness | null;
  market_cap_usd: number | null;
  market_cap_native: number | null;
  market_cap_ccy: string | null;
  is_top10: boolean;
  applicable_line: string | null;
  lower_line_positive: boolean | null;
  is_discount: boolean;
  state: string;
  total_count: number;
  country: string | null;
  /** Country of the exchange the row is listed on. */
  listing_country: string | null;
  /** Yahoo exchange code, when the list provides it (the home ticker falls back to `listing_country`). */
  exchange_code?: string | null;
}

export interface SummaryCompany {
  company_id: string;
  name: string;
  date?: string;
}
/** `public.universe_summary(p_mode)` (the short summary, worldwide). */
export interface ShortSummary {
  as_of: string | null;
  added_today: SummaryCompany[];
  removed_today: SummaryCompany[];
  added_7d: SummaryCompany[];
  removed_7d: SummaryCompany[];
}

/** `public.get_price_series(p_security_id)`: parallel arrays, `bar_dates` = days since 1970-01-01. */
export interface PriceSeries {
  security_id: string;
  bar_dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  bar_count: number;
  first_bar_date: string;
  last_bar_date: string;
  last_session_date: string;
  last_close: number;
  prev_close: number | null;
  freshness: Freshness;
}
