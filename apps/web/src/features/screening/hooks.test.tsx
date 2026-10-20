import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchScanStatus: vi.fn(),
  fetchTodaysDiscounts: vi.fn(),
  fetchCompanyList: vi.fn(),
  fetchShortSummary: vi.fn(),
  fetchPriceSeries: vi.fn(),
}));
vi.mock("./api", () => api);
const qapi = vi.hoisted(() => ({
  fetchQuotes: vi.fn(),
  fetchChartBySymbol: vi.fn(),
  searchSymbols: vi.fn(),
}));
vi.mock("./quotes-api", () => qapi);

import {
  CHART_GC_MS,
  CHART_STALE_MS,
  LIVE_POLL_MS,
  noteScanAccepted,
  POLL_MS,
  queryKeys,
  STALE_MS,
  STATUS_POLL_MS,
  useCompanyList,
  usePriceSeries,
  useScanStatus,
  useShortSummary,
  useTodaysDiscounts,
} from "./hooks";
import { quotesKeys, useChartBySymbol, useQuotes, useSymbolSearch } from "./quotes-hooks";
import type { CompanyListRow } from "./types";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function options(key: readonly unknown[]) {
  const q = client.getQueryCache().find({ queryKey: key });
  if (!q) throw new Error(`no query for ${JSON.stringify(key)}`);
  return q.options as Record<string, unknown>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const m of [...Object.values(api), ...Object.values(qapi)]) m.mockReset();
  for (const m of Object.values(api)) m.mockResolvedValue([]);
  qapi.fetchQuotes.mockResolvedValue([]);
  qapi.searchSymbols.mockResolvedValue([]);
});

describe("data hooks: keys and cadence", () => {
  it("scan status polls every 60 s while visible", async () => {
    api.fetchScanStatus.mockResolvedValue({});
    renderHook(() => useScanStatus(), { wrapper });
    const o = options(queryKeys.scanStatus);
    expect(queryKeys.scanStatus).toEqual(["scanStatus"]);
    expect(o["staleTime"]).toBe(STALE_MS);
    expect(STALE_MS).toBe(60_000);
    expect(o["refetchInterval"]).toBe(STATUS_POLL_MS);
    expect(STATUS_POLL_MS).toBe(60_000);
    expect(o["refetchIntervalInBackground"]).toBe(false);
  });

  it("summary and company list poll every 5 min, visible only", async () => {
    renderHook(
      () => {
        useTodaysDiscounts();
        useShortSummary();
        useCompanyList();
      },
      { wrapper },
    );
    for (const key of [["shortSummary"], ["companyList", "all"]] as const) {
      const o = options(key);
      expect(o["staleTime"]).toBe(60_000);
      expect(o["refetchInterval"]).toBe(5 * 60_000);
      expect(o["refetchIntervalInBackground"]).toBe(false);
    }
    expect(POLL_MS).toBe(300_000);
    expect(queryKeys.discounts).toEqual(["discounts"]);
    expect(queryKeys.companyList(null)).toEqual(["companyList", "all"]);
    expect(queryKeys.companyList("United States")).toEqual(["companyList", "United States"]);
    expect(queryKeys.shortSummary).toEqual(["shortSummary"]);
    expect(queryKeys.chart("s1")).toEqual(["chart", "s1"]);
  });
});

describe("useCompanyList paging", () => {
  it("requests 15 first, then 25 after the last rank", async () => {
    const row = (rank: number): CompanyListRow => ({ rank, total_count: 100 }) as CompanyListRow;
    api.fetchCompanyList.mockResolvedValueOnce(Array.from({ length: 15 }, (_, i) => row(i + 1)));
    api.fetchCompanyList.mockResolvedValueOnce([row(16)]);
    const { result } = renderHook(() => useCompanyList(), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(api.fetchCompanyList).toHaveBeenNthCalledWith(1, null, 15, null);
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(api.fetchCompanyList).toHaveBeenNthCalledWith(2, 15, 25, null);
  });
});

describe("usePriceSeries", () => {
  it("is disabled without a security id and enabled with one", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => usePriceSeries(id),
      { wrapper, initialProps: { id: undefined as string | undefined } },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.fetchPriceSeries).not.toHaveBeenCalled();
    api.fetchPriceSeries.mockResolvedValue({ security_id: "s1" });
    rerender({ id: "s1" });
    await waitFor(() => expect(api.fetchPriceSeries).toHaveBeenCalledWith("s1"));
    const o = options(["chart", "s1"]);
    expect(o["staleTime"]).toBe(CHART_STALE_MS);
    expect(o["gcTime"]).toBe(CHART_GC_MS);
  });
});

describe("quotes hooks", () => {
  it("useQuotes sorts and dedupes the key, polls every 5 min, and is disabled when empty", async () => {
    const { result } = renderHook(() => useQuotes(["B", "A", "B"]), { wrapper });
    await waitFor(() => expect(qapi.fetchQuotes).toHaveBeenCalledWith(["A", "B"]));
    const o = options(["quotes", ["A", "B"]]);
    expect(quotesKeys.quotes(["A", "B"])).toEqual(["quotes", ["A", "B"]]);
    expect(o["staleTime"]).toBe(POLL_MS);
    expect(o["refetchInterval"]).toBe(POLL_MS);
    expect(o["refetchIntervalInBackground"]).toBe(false);
    expect(result.current.isError).toBe(false);
    qapi.fetchQuotes.mockClear();
    const empty = renderHook(() => useQuotes([]), { wrapper });
    expect(empty.result.current.fetchStatus).toBe("idle");
    expect(qapi.fetchQuotes).not.toHaveBeenCalled();
  });

  it("useChartBySymbol is enabled only with a symbol", () => {
    const off = renderHook(() => useChartBySymbol(undefined), { wrapper });
    expect(off.result.current.fetchStatus).toBe("idle");
    qapi.fetchChartBySymbol.mockResolvedValue({});
    renderHook(() => useChartBySymbol("SAP.DE"), { wrapper });
    expect(qapi.fetchChartBySymbol).toHaveBeenCalledWith("SAP.DE");
    const o = options(quotesKeys.chartSymbol("SAP.DE"));
    expect(o["staleTime"]).toBe(CHART_STALE_MS);
    expect(o["gcTime"]).toBe(CHART_GC_MS);
  });

  it("useSymbolSearch needs 2 trimmed characters and lowercases the key", async () => {
    const short = renderHook(() => useSymbolSearch(" a "), { wrapper });
    expect(short.result.current.fetchStatus).toBe("idle");
    renderHook(() => useSymbolSearch(" SAP "), { wrapper });
    await waitFor(() => expect(qapi.searchSymbols).toHaveBeenCalledWith("SAP"));
    expect(quotesKeys.search("sap")).toEqual(["search", "sap"]);
    expect(options(["search", "sap"])["staleTime"]).toBe(3_600_000);
  });

  describe("discounts polling", () => {
    const interval = () => {
      renderHook(() => useTodaysDiscounts(), { wrapper });
      const fn = options(queryKeys.discounts)["refetchInterval"] as (q: unknown) => unknown;
      return (rows: unknown) => fn({ state: { data: rows } });
    };
    const NOW = new Date("2026-10-20T12:00:00Z");
    const running = {
      research_started_at: "2026-10-20T11:59:00Z",
      research_requested_by: "visitor",
    };
    const idle = {
      research_started_at: null,
      research_requested_by: null,
      research_wait_reason: null,
      research_completed_at: null,
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      noteScanAccepted(0);
    });
    afterEach(() => vi.useRealTimers());

    it("polls every 5 minutes while nothing is in flight, visible only", () => {
      const at = interval();
      expect(at(undefined)).toBe(POLL_MS);
      expect(at([idle])).toBe(POLL_MS);
      expect(options(queryKeys.discounts)["refetchIntervalInBackground"]).toBe(false);
      expect(LIVE_POLL_MS).toBe(15_000);
    });

    it("polls every 15 s while any row of the feed is running", () => {
      expect(interval()([idle, running])).toBe(LIVE_POLL_MS);
    });

    it("keeps polling every 15 s for 2 minutes after a scan was accepted on this page", () => {
      const at = interval();
      noteScanAccepted(NOW.getTime() - 119_000);
      expect(at([idle])).toBe(LIVE_POLL_MS);
      noteScanAccepted(NOW.getTime() - 121_000);
      expect(at([idle])).toBe(POLL_MS);
    });

    it("a quota-paused report does not count as running", () => {
      const paused = { ...running, research_wait_reason: "llm_quota" };
      expect(interval()([paused])).toBe(POLL_MS);
    });
  });
});
