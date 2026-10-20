import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateQuotesSearch } from "@/features/screening/search-params";
import { makeBars, seriesFromBars } from "@/test/bars";
import { makeDiscount, makeScanStatus } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const api = vi.hoisted(() => ({
  fetchTodaysDiscounts: vi.fn(),
  fetchPriceSeries: vi.fn(),
  fetchScanStatus: vi.fn(),
}));
const q = vi.hoisted(() => ({
  searchSymbols: vi.fn(),
  fetchChartBySymbol: vi.fn(),
  fetchQuotes: vi.fn(),
  fetchQuotesDetailed: vi.fn(),
}));
vi.mock("@/features/screening/api", () => ({
  ...api,
  fetchCompanyList: vi.fn(),
  fetchShortSummary: vi.fn(),
}));
vi.mock("@/features/screening/quotes-api", () => q);
vi.mock("./std-dev-channel-chart", () => ({
  StdDevChannelChart: (p: {
    bars: unknown[];
    indicatorVisible: boolean;
    rangeRequest: { range: string } | null;
    channel: { status: string };
    chartType: string;
  }) => (
    <div
      data-testid="chart"
      data-bars={p.bars.length}
      data-indicator={String(p.indicatorVisible)}
      data-range={p.rangeRequest?.range ?? ""}
      data-channel={p.channel.status}
      data-type={p.chartType}
    />
  ),
}));

import { QuotesPage } from "./quotes-page";

const longBars = makeBars(2600);
const shortBars = makeBars(100);
const msft = makeDiscount({
  rank: 53,
  yahoo_symbol: "MSFT",
  name: "Microsoft Corporation",
  security_id: "sid-msft",
  exchange_code: "NMS",
  currency: "USD",
});
const asml = makeDiscount({
  rank: 12,
  yahoo_symbol: "ASML.AS",
  name: "ASML Holding",
  security_id: "sid-asml",
  exchange_code: "AMS",
  currency: "EUR",
});

beforeEach(() => {
  for (const f of [...Object.values(api), ...Object.values(q)]) f.mockReset();
  api.fetchScanStatus.mockResolvedValue(makeScanStatus());
  api.fetchTodaysDiscounts.mockResolvedValue([msft, asml]);
  api.fetchPriceSeries.mockImplementation(async (sid: string) =>
    seriesFromBars(sid === "sid-short" ? shortBars : longBars, sid),
  );
  q.fetchQuotes.mockResolvedValue([]);
  q.fetchQuotesDetailed.mockResolvedValue({
    quotes: [],
    missing: [],
    unavailable: [],
    fetchedAt: "2026-10-15T08:00:00Z",
    stale: false,
  });
  q.searchSymbols.mockResolvedValue([
    {
      symbol: "NVDA",
      exchange: "NMS",
      quoteType: "EQUITY",
      longName: "NVIDIA Corporation",
      shortName: "NVIDIA",
    },
  ]);
  q.fetchChartBySymbol.mockResolvedValue({
    symbol: "NVDA",
    currency: "USD",
    exchange: "NMS",
    exchangeTimezoneName: "America/New_York",
    longName: "NVIDIA Corporation",
    ...Object.fromEntries(
      Object.entries(seriesFromBars(longBars, "x")).filter(([k]) =>
        ["bar_dates", "open", "high", "low", "close", "volume"].includes(k),
      ),
    ),
    regularMarketTime: null,
    marketState: "CLOSED",
    fetchedAt: "2026-10-15T08:00:00Z",
    stale: false,
  });
});
afterEach(cleanup);

const mount = (url = "/quotes") =>
  renderWithProviders(<QuotesPage />, {
    path: "/quotes",
    url,
    validateSearch: validateQuotesSearch,
  });

describe("QuotesPage", () => {
  it("empty state when there are no discounts, with search still available", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([]);
    mount();
    expect(
      await screen.findByText("No stocks are in today's list. Search for a security manually."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Search for a security")).toBeTruthy();
    expect(screen.queryByTestId("chart")).toBeNull();
  });

  it("lists every company on today's list in rank order, withheld and unscanned ones too", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      msft,
      makeDiscount({
        rank: 30,
        yahoo_symbol: "RED",
        name: "Red Flag Corp",
        security_id: "sid-red",
        operational_category: "red",
        withheld: true,
      }),
      makeDiscount({
        rank: 40,
        yahoo_symbol: "NEW",
        name: "Unscanned Inc",
        security_id: "sid-new",
        operational_category: "pending",
        category_reason: "not_requested",
        withheld: true,
      }),
      asml,
    ]);
    mount();
    const select = (await screen.findByLabelText("Select a stock from today")) as HTMLSelectElement;
    const labels = Array.from(select.options)
      .map((o) => o.textContent)
      .filter((t) => t?.startsWith("#"));
    expect(labels).toEqual([
      "#12 ASML — ASML Holding",
      "#30 RED — Red Flag Corp",
      "#40 NEW — Unscanned Inc",
      "#53 MSFT — Microsoft Corporation",
    ]);
  });

  it("preselects from ?symbol= and loads the stored series for that security", async () => {
    mount("/quotes?symbol=ASML.AS");
    const select = (await screen.findByLabelText("Select a stock from today")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("ASML.AS"));
    await screen.findByTestId("chart");
    expect(api.fetchPriceSeries).toHaveBeenCalledWith("sid-asml");
    expect(q.fetchChartBySymbol).not.toHaveBeenCalled();
    expect(screen.getByTestId("chart").getAttribute("data-bars")).toBe("2600");
    expect(screen.getByTestId("chart").getAttribute("data-channel")).toBe("ok");
  });

  it("shows both external links for the same listing with the verified TradingView prefix", async () => {
    mount("/quotes?symbol=ASML.AS");
    const tv = (await screen.findByRole("link", {
      name: "View on TradingView",
    })) as HTMLAnchorElement;
    const yh = screen.getByRole("link", { name: "View on Yahoo Finance" }) as HTMLAnchorElement;
    expect(tv.getAttribute("href")).toBe("https://www.tradingview.com/symbols/EURONEXT-ASML/");
    expect(yh.getAttribute("href")).toBe("https://finance.yahoo.com/quote/ASML.AS/");
    expect(tv.getAttribute("rel")).toBe("noopener noreferrer");
    expect(tv.className).toContain("underline");
  });

  it("typing in the search box never changes the selected instrument", async () => {
    mount("/quotes?symbol=MSFT");
    const select = (await screen.findByLabelText("Select a stock from today")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("MSFT"));
    fireEvent.change(screen.getByLabelText("Search for a security"), {
      target: { value: "nvidia" },
    });
    await screen.findByRole("button", { name: /NVDA/ });
    expect(select.value).toBe("MSFT");
    expect(q.fetchChartBySymbol).not.toHaveBeenCalled();
  });

  it("picking a search result selects it explicitly: URL updates and the chart loads by symbol", async () => {
    const { router } = mount("/quotes?symbol=MSFT");
    await screen.findByLabelText("Select a stock from today");
    fireEvent.change(screen.getByLabelText("Search for a security"), {
      target: { value: "nvidia" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /NVDA/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ symbol: "NVDA" }));
    await waitFor(() => expect(q.fetchChartBySymbol).toHaveBeenCalledWith("NVDA"));
    const tv = (await screen.findByRole("link", {
      name: "View on TradingView",
    })) as HTMLAnchorElement;
    expect(tv.getAttribute("href")).toBe("https://www.tradingview.com/symbols/NASDAQ-NVDA/");
  });

  it("fewer than 2,500 bars: no channel and the explicit notice", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "SHRT", security_id: "sid-short", name: "Short History Co" }),
    ]);
    mount("/quotes?symbol=SHRT");
    expect(
      await screen.findByText("Not enough history for the channel (100 of 2,500 bars)"),
    ).toBeTruthy();
    expect(screen.getByTestId("chart").getAttribute("data-channel")).toBe("insufficient");
  });

  it("range buttons and the indicator toggle reach the chart", async () => {
    mount("/quotes?symbol=MSFT");
    await screen.findByTestId("chart");
    fireEvent.click(screen.getByRole("button", { name: "5D" }));
    expect(screen.getByTestId("chart").getAttribute("data-range")).toBe("5D");
    fireEvent.click(screen.getByRole("button", { name: "Hide indicator" }));
    expect(screen.getByTestId("chart").getAttribute("data-indicator")).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: "Line" }));
    expect(screen.getByTestId("chart").getAttribute("data-type")).toBe("line");
  });

  it("applying new indicator settings recomputes the channel; Reset restores the defaults", async () => {
    mount("/quotes?symbol=MSFT");
    await screen.findByTestId("chart");
    fireEvent.click(screen.getByRole("button", { name: "Indicator settings" }));
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(screen.getByTestId("chart").getAttribute("data-channel")).toBe("insufficient"),
    );
    expect(
      screen.getByText("Not enough history for the channel (2,600 of 5,000 bars)"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() =>
      expect(screen.getByTestId("chart").getAttribute("data-channel")).toBe("ok"),
    );
  });

  it("shows the accessible channel table, the text summary and the attribution notice", async () => {
    mount("/quotes?symbol=MSFT");
    await screen.findByTestId("chart");
    const table = screen.getByRole("table", { name: /Channel values at the latest bar/ });
    expect(within(table).getByText("Last close")).toBeTruthy();
    for (const t of ["+2", "+1", "Base", "-3", "-4"])
      expect(within(table).getByText(t)).toBeTruthy();
    expect(screen.getByText(/Last close .* on .* is .* the -3 line/)).toBeTruthy();
    expect(screen.getByText(/TradingView Lightweight Charts/)).toBeTruthy();
  });

  it("an unavailable quote shows a retry hint, not an unknown-symbol message", async () => {
    q.fetchQuotesDetailed.mockResolvedValue({
      quotes: [],
      missing: [],
      unavailable: ["MSFT"],
      fetchedAt: "2026-10-15T08:00:00Z",
      stale: false,
    });
    mount("/quotes?symbol=MSFT");
    expect(await screen.findByText(/Delayed quote unavailable right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(q.fetchQuotesDetailed.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByTestId("chart")).toBeTruthy();
  });

  it("a missing (unknown) symbol shows no quote line and no retry hint", async () => {
    q.fetchQuotesDetailed.mockResolvedValue({
      quotes: [],
      missing: ["MSFT"],
      unavailable: [],
      fetchedAt: "2026-10-15T08:00:00Z",
      stale: false,
    });
    mount("/quotes?symbol=MSFT");
    await screen.findByTestId("chart");
    await waitFor(() => expect(q.fetchQuotesDetailed).toHaveBeenCalled());
    expect(screen.queryByText(/Delayed quote unavailable/)).toBeNull();
  });

  it("a 503/502 on the quote request shows the retry hint and keeps the chart", async () => {
    q.fetchQuotesDetailed.mockRejectedValue(new Error("busy, retry shortly"));
    mount("/quotes?symbol=MSFT");
    expect(
      await screen.findByText(/Delayed quote unavailable right now/, {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByTestId("chart")).toBeTruthy();
  });

  it("shows an error state with Retry when the series cannot be loaded", async () => {
    api.fetchPriceSeries.mockRejectedValue(new Error("boom"));
    mount("/quotes?symbol=MSFT");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
