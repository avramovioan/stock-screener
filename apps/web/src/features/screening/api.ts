import { supabase } from "@/lib/supabase";
import { ApiError, toApiError } from "./errors";
import { RPC } from "./rpc-names";
import { FEED_MODE } from "./search-params";
import type {
  CompanyListRow,
  DiscountRow,
  PriceSeries,
  ResearchQuotaStatus,
  ScanStatus,
  ShortSummary,
} from "./types";

interface RpcResult {
  data: unknown;
  error: { code?: string; message: string } | null;
  status: number;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  let res: RpcResult;
  try {
    // Names are validated against the generated types by rpc-names.test.ts.
    res = (await supabase.rpc(fn as never, args as never)) as unknown as RpcResult;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw toApiError({ status: 0, message: e instanceof Error ? e.message : String(e) });
  }
  if (res.error) {
    throw toApiError({ status: res.status, code: res.error.code, message: res.error.message });
  }
  return res.data as T;
}

export function fetchScanStatus(): Promise<ScanStatus> {
  return rpc<ScanStatus>(RPC.scanStatus);
}

export function fetchResearchQuota(): Promise<ResearchQuotaStatus> {
  return rpc<ResearchQuotaStatus>(RPC.researchQuota);
}

export async function fetchTodaysDiscounts(): Promise<DiscountRow[]> {
  return (await rpc<DiscountRow[] | null>(RPC.discountsFeed, { p_mode: FEED_MODE })) ?? [];
}

export async function fetchCompanyList(
  afterRank: number | null,
  limit: number,
  country: string | null = null,
): Promise<CompanyListRow[]> {
  return (
    (await rpc<CompanyListRow[] | null>(RPC.companyList, {
      p_mode: FEED_MODE,
      p_after_rank: afterRank,
      p_limit: limit,
      p_country: country,
    })) ?? []
  );
}

export function fetchShortSummary(): Promise<ShortSummary> {
  return rpc<ShortSummary>(RPC.shortSummary, { p_mode: FEED_MODE });
}

export function fetchPriceSeries(securityId: string): Promise<PriceSeries> {
  return rpc<PriceSeries>(RPC.priceSeries, { p_security_id: securityId });
}
