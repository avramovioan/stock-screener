import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({ supabase: { rpc } }));

import {
  fetchCompanyList,
  fetchPriceSeries,
  fetchScanStatus,
  fetchShortSummary,
  fetchTodaysDiscounts,
} from "./api";

beforeEach(() => {
  rpc.mockReset(); // not returned: a returned function would be run by vitest as a teardown
});

describe("api", () => {
  it("fetchScanStatus calls scan_status without arguments", async () => {
    rpc.mockResolvedValue({ data: { last_attempted: null }, error: null, status: 200 });
    await expect(fetchScanStatus()).resolves.toEqual({ last_attempted: null });
    expect(rpc).toHaveBeenCalledWith("scan_status", undefined);
  });
  it("fetchTodaysDiscounts always reads the worldwide ranking", async () => {
    rpc.mockResolvedValue({ data: [], error: null, status: 200 });
    await fetchTodaysDiscounts();
    expect(rpc).toHaveBeenCalledWith("todays_discounts_feed", { p_mode: "worldwide" });
  });
  it("fetchCompanyList passes the keyset arguments", async () => {
    rpc.mockResolvedValue({ data: [], error: null, status: 200 });
    await fetchCompanyList(15, 25);
    expect(rpc).toHaveBeenCalledWith("company_list", {
      p_mode: "worldwide",
      p_after_rank: 15,
      p_limit: 25,
      p_country: null,
    });
    await fetchCompanyList(null, 15);
    expect(rpc).toHaveBeenLastCalledWith("company_list", {
      p_mode: "worldwide",
      p_after_rank: null,
      p_limit: 15,
      p_country: null,
    });
    await fetchCompanyList(null, 15, "United States");
    expect(rpc).toHaveBeenLastCalledWith("company_list", {
      p_mode: "worldwide",
      p_after_rank: null,
      p_limit: 15,
      p_country: "United States",
    });
  });
  it("fetchShortSummary and fetchPriceSeries call their RPCs", async () => {
    rpc.mockResolvedValue({ data: {}, error: null, status: 200 });
    await fetchShortSummary();
    expect(rpc).toHaveBeenLastCalledWith("universe_summary", { p_mode: "worldwide" });
    await fetchPriceSeries("sid-1");
    expect(rpc).toHaveBeenLastCalledWith("get_price_series", { p_security_id: "sid-1" });
  });
  it("maps a PostgREST error to ApiError with a kind", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" }, status: 403 });
    await expect(fetchScanStatus()).rejects.toMatchObject({ name: "ApiError", kind: "rls_denied" });
  });
  it("maps a thrown fetch failure to network", async () => {
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchScanStatus()).rejects.toMatchObject({ kind: "network" });
  });
});
