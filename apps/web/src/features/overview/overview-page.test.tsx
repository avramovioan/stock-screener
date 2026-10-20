import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateOverviewSearch } from "@/features/screening/search-params";
import { makeCompanyRow, makeDiscount, makeScanStatus } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const api = vi.hoisted(() => ({
  fetchScanStatus: vi.fn(),
  fetchTodaysDiscounts: vi.fn(),
  fetchCompanyList: vi.fn(),
  fetchShortSummary: vi.fn(),
}));
vi.mock("@/features/screening/api", () => ({ ...api, fetchPriceSeries: vi.fn() }));
vi.mock("@/features/screening/quotes-api", () => ({
  fetchQuotes: vi.fn().mockResolvedValue([]),
  searchSymbols: vi.fn(),
  fetchChartBySymbol: vi.fn(),
}));
const live = vi.hoisted(() => ({ useResearchLive: vi.fn() }));
vi.mock("@/features/screening/use-research-live", () => live);

import { OverviewPage } from "./overview-page";

const summary = {
  as_of: "2026-10-15",
  added_today: [{ company_id: "a", name: "Added Co" }],
  removed_today: [],
  added_7d: [
    { company_id: "a", name: "Added Co", date: "2026-10-15" },
    { company_id: "b", name: "Other Co", date: "2026-10-12" },
  ],
  removed_7d: [{ company_id: "c", name: "Removed Co", date: "2026-10-13" }],
};

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  for (const f of Object.values(api)) f.mockReset();
  api.fetchScanStatus.mockResolvedValue(makeScanStatus());
  api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount()]);
  // like the database: the country filter is applied to the list, total_count counts the filtered set
  api.fetchCompanyList.mockImplementation(
    async (_after: number | null, _limit: number, country: string | null) => {
      const all = Array.from({ length: 3 }, (_, i) => ({
        i,
        country: i === 1 ? "Japan" : "United States",
      })).filter((r) => country === null || r.country === country);
      return all.map((r) =>
        makeCompanyRow(r.i + 1, all.length, { name: `Company ${r.i + 1}`, country: r.country }),
      );
    },
  );
  api.fetchShortSummary.mockResolvedValue(summary);
});
afterEach(cleanup);

const mount = (url = "/") =>
  renderWithProviders(<OverviewPage />, { path: "/", url, validateSearch: validateOverviewSearch });

describe("OverviewPage", () => {
  it("opens the live research channel once for the page", async () => {
    live.useResearchLive.mockClear();
    mount();
    await screen.findByRole("heading", { level: 1, name: "Today's discounts" });
    expect(live.useResearchLive).toHaveBeenCalled();
  });

  it("renders the heading block, the sentences and the last scan time", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Today's discounts" }),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "1 company closed at or below its −3 line. 612 of 612 companies worth US$50B or more were evaluated.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Last scan Oct 15, 10:41 Sofia time")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "The Company List" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The short summary" })).toBeTruthy();
    expect(
      screen.getByText(
        /Worldwide ranking by market capitalization\. A close at or below the −3 line is a discount/,
      ),
    ).toBeTruthy();
  });

  it("has no collapsible anywhere on the page", async () => {
    const { container } = mount();
    await screen.findAllByTestId("company-row");
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText(/Coverage details/)).toBeNull();
    expect(screen.queryByTestId("withheld-panel")).toBeNull();
  });

  it("always reads the worldwide ranking, whatever ?mode= says", async () => {
    mount("/?mode=us");
    await screen.findAllByTestId("company-row");
    expect(api.fetchCompanyList).toHaveBeenCalledWith(null, 15, null);
    expect(api.fetchTodaysDiscounts).toHaveBeenCalledWith();
    expect(api.fetchShortSummary).toHaveBeenCalledWith();
  });

  it("offers Listed in with All exchanges selected by default, for everyone", async () => {
    mount();
    const group = await screen.findByRole("radiogroup", { name: "Listed in" });
    expect(
      (within(group).getByRole("radio", { name: "All exchanges" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(group).getByRole("radio", { name: "United States" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      screen.getByText(
        "United States = listed on NYSE or Nasdaq, whatever the company's home country (Aon stays in).",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Change in Profile" })).toBeNull();
  });

  it("?country=us starts on United States and filters the cards, the sentence and the list", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "US1", rank: 1 }),
      makeDiscount({
        yahoo_symbol: "JP1",
        rank: 2,
        country: "Japan",
        listing_country: "Japan",
        security_id: "s2",
      }),
    ]);
    mount("/?country=us");
    expect(await screen.findByText(/^1 US company closed at or below its −3 line./)).toBeTruthy();
    await screen.findAllByTestId("company-row");
    expect(screen.getAllByTestId("discount-card")).toHaveLength(1);
    expect(screen.getAllByTestId("company-row")).toHaveLength(2);
    const group = screen.getByRole("radiogroup", { name: "Listed in" });
    expect(
      (within(group).getByRole("radio", { name: "United States" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("choosing United States updates the URL, the cards and the list; All exchanges restores them", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "US1", rank: 1 }),
      makeDiscount({
        yahoo_symbol: "JP1",
        rank: 2,
        country: "Japan",
        listing_country: "Japan",
        security_id: "s2",
      }),
    ]);
    const { router } = mount();
    expect(await screen.findByText(/^2 companies closed at or below their −3 line./)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "United States" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ country: "us" }));
    expect(await screen.findByText(/^1 US company closed at or below its −3 line./)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("company-row")).toHaveLength(2));
    fireEvent.click(screen.getByRole("radio", { name: "All exchanges" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(screen.getAllByTestId("company-row")).toHaveLength(3));
  });

  it("the sentence links to How it works", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "How it works" });
    expect(link.getAttribute("href")).toBe("/how-it-works");
    expect(link.closest("p")?.textContent).toMatch(/closed at or below/);
  });

  it("zero matches uses the plain sentence", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([]);
    mount();
    expect(
      await screen.findByText(/^No companies closed at or below their −3 line today./),
    ).toBeTruthy();
  });

  it("the list is replaced by a plain panel while it is not published", async () => {
    const base = makeScanStatus();
    api.fetchScanStatus.mockResolvedValue(
      makeScanStatus({
        latest_published: {
          ...(base.latest_published as NonNullable<typeof base.latest_published>),
          coverage: {
            candidates: { total: 640, processed: 557 },
            publish: { results: true, list: false, list_coverage: 0.87 },
          },
        },
      }),
    );
    mount();
    expect(await screen.findByText("Today's list isn't published yet")).toBeTruthy();
    expect(
      screen.getByText(
        "It appears once at least 95% of companies are evaluated. Today's scan reached 87%.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("company-row")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("the short summary shows the four counts and opens each company list in a popover", async () => {
    mount();
    const section = (await screen.findByRole("heading", { name: "The short summary" })).closest(
      "section",
    ) as HTMLElement;
    await within(section).findByRole("button", { name: /Added today: 1/ });
    expect(within(section).getByRole("button", { name: /Removed today: 0/ })).toBeTruthy();
    expect(
      within(section).getByRole("button", { name: /Added in the last 7 days: 2/ }),
    ).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: /Removed in the last 7 days: 1/ }));
    const dialog = within(section).getByRole("dialog", { name: "Removed in the last 7 days" });
    expect(dialog.textContent).toContain("Removed Co");
    expect(dialog.textContent).toContain("13 Oct 2026");
  });

  it("summary unavailable is explicit, never zeros", async () => {
    api.fetchShortSummary.mockResolvedValue({
      as_of: null,
      added_today: [],
      removed_today: [],
      added_7d: [],
      removed_7d: [],
    });
    mount();
    expect(await screen.findByText(/summary is not available yet/i)).toBeTruthy();
  });
});
