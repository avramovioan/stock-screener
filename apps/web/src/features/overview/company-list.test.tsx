import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCompanyRow } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const api = vi.hoisted(() => ({ fetchCompanyList: vi.fn() }));
vi.mock("@/features/screening/api", () => ({
  ...api,
  fetchScanStatus: vi.fn(),
  fetchTodaysDiscounts: vi.fn(),
  fetchShortSummary: vi.fn(),
  fetchPriceSeries: vi.fn(),
}));

import { CompanyList } from "./company-list";

function mockMatchMedia(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === "(max-width: 639px)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const range = (from: number, to: number, total: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => makeCompanyRow(from + i, total));

beforeEach(() => {
  mockMatchMedia(false);
  api.fetchCompanyList.mockReset();
  api.fetchCompanyList.mockImplementation(async (after: number | null) =>
    after === null ? range(1, 15, 40) : range(16, 40, 25),
  );
});
afterEach(cleanup);

describe("CompanyList tickers", () => {
  it("shows the home ticker of a non-US row and keeps a US symbol", async () => {
    api.fetchCompanyList.mockResolvedValue([
      makeCompanyRow(1, 2, {
        yahoo_symbol: "RMS.PA",
        exchange_code: "PAR",
        country: "France",
        listing_country: "France",
      }),
      makeCompanyRow(2, 2, { yahoo_symbol: "BRK.B", listing_country: "United States" }),
    ]);
    renderWithProviders(<CompanyList filter="all" />);
    const rows = await screen.findAllByTestId("company-row");
    expect(within(rows[0] as HTMLElement).getByText("RMS")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("BRK.B")).toBeTruthy();
  });
});

describe("CompanyList", () => {
  it("shows the first 15 rows and a Load more button", async () => {
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    expect(screen.getAllByTestId("company-row")).toHaveLength(15);
    expect(api.fetchCompanyList).toHaveBeenCalledWith(null, 15, null);
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("Load more appends 25 rows with the rank cursor, then disappears", async () => {
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByTestId("company-row")).toHaveLength(40));
    expect(api.fetchCompanyList).toHaveBeenLastCalledWith(15, 25, null);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("renders columns Rank / Company / Country / Price / Today / Market cap", async () => {
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    for (const name of ["Rank", "Company", "Country", "Price", "Today", "Market cap"]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
    const first = screen.getAllByTestId("company-row")[0] as HTMLElement;
    expect(within(first).getByText("#1")).toBeTruthy();
    expect(within(first).getByText("Company 1")).toBeTruthy();
    expect(within(first).getByText("T1")).toBeTruthy();
    expect(within(first).getByText("United States")).toBeTruthy();
    expect(first.querySelector("[data-flag='US']")).toBeTruthy();
    expect(within(first).getByText("$101.00")).toBeTruthy();
    expect(within(first).getByText("+0.50%")).toBeTruthy();
    expect(within(first).getByText("$999B")).toBeTruthy();
  });

  it("an unknown country is named Unknown with the neutral flag", async () => {
    api.fetchCompanyList.mockResolvedValue([makeCompanyRow(1, 1, { country: null })]);
    renderWithProviders(<CompanyList filter="all" />);
    const row = (await screen.findAllByTestId("company-row"))[0] as HTMLElement;
    expect(within(row).getByText("Unknown")).toBeTruthy();
    expect(row.querySelector("[data-flag='unknown']")).toBeTruthy();
  });

  it("highlights only the top 10 rows and describes them to assistive technology", async () => {
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    const rows = screen.getAllByTestId("company-row");
    expect(rows[9]?.getAttribute("aria-description")).toBe("Top 10");
    expect(rows[9]?.className).toContain("row-top10");
    expect(within(rows[9] as HTMLElement).getByText("Top 10")).toBeTruthy();
    expect(rows[10]?.getAttribute("aria-description")).toBeNull();
  });

  it("stale price: Stale price in the Today column; unavailable: n/a", async () => {
    api.fetchCompanyList.mockResolvedValue([
      makeCompanyRow(1, 3, { price_freshness: "stale", session_date: "2026-10-09" }),
      makeCompanyRow(2, 3, { price_freshness: "unavailable", last_close: null, change_pct: null }),
      makeCompanyRow(3, 3),
    ]);
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    const [stale, unavailable] = screen.getAllByTestId("company-row") as HTMLElement[];
    const staleText = within(stale as HTMLElement).getByText("Stale price");
    expect(staleText.getAttribute("title")).toBe("Close 9 Oct 2026");
    expect(within(unavailable as HTMLElement).getAllByText("n/a").length).toBeGreaterThan(0);
  });

  it("a carried-forward row is flagged as not updated today", async () => {
    api.fetchCompanyList.mockResolvedValue([
      makeCompanyRow(1, 2, { state: "carried_forward" }),
      makeCompanyRow(2, 2),
    ]);
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    const [carried, normal] = screen.getAllByTestId("company-row") as HTMLElement[];
    expect(within(carried as HTMLElement).getByText("Not updated today")).toBeTruthy();
    expect(within(normal as HTMLElement).queryByText("Not updated today")).toBeNull();
  });

  it("empty list explains itself", async () => {
    api.fetchCompanyList.mockResolvedValue([]);
    renderWithProviders(<CompanyList filter="all" />);
    expect(await screen.findByText("No companies in this list yet")).toBeTruthy();
  });

  it("below 640 px each row is a stacked entry with the country line", async () => {
    mockMatchMedia(true);
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-card");
    expect(screen.queryByRole("table")).toBeNull();
    const card = screen.getAllByTestId("company-card")[0] as HTMLElement;
    for (const text of ["#1", "Company 1", "United States, T1", "$101.00", "+0.50%"]) {
      expect(within(card).getByText(text)).toBeTruthy();
    }
    expect(card.querySelector("[data-flag='US']")).toBeTruthy();
  });
});

describe("CompanyList country filter", () => {
  it("asks the database for United States rows and shows them as they come", async () => {
    api.fetchCompanyList.mockImplementation(async (_after: number | null, limit: number) =>
      Array.from({ length: limit }, (_, i) =>
        makeCompanyRow(i + 1, 40, { country: "United States" }),
      ),
    );
    renderWithProviders(<CompanyList filter="us" />);
    await waitFor(() => expect(screen.getAllByTestId("company-row")).toHaveLength(15));
    expect(api.fetchCompanyList).toHaveBeenCalledTimes(1);
    expect(api.fetchCompanyList).toHaveBeenCalledWith(null, 15, "United States");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.fetchCompanyList).toHaveBeenCalledTimes(2));
    expect(api.fetchCompanyList).toHaveBeenLastCalledWith(15, 25, "United States");
  });

  it("says so when no company matches and offers no Load more", async () => {
    api.fetchCompanyList.mockResolvedValue([]);
    renderWithProviders(<CompanyList filter="us" />);
    expect(await screen.findByText("No companies in this list yet")).toBeTruthy();
    expect(screen.getByText(/No United States company/)).toBeTruthy();
    expect(screen.queryByTestId("company-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("all countries sends no country", async () => {
    api.fetchCompanyList.mockResolvedValue(range(1, 4, 4));
    renderWithProviders(<CompanyList filter="all" />);
    await screen.findAllByTestId("company-row");
    expect(screen.getAllByTestId("company-row")).toHaveLength(4);
    expect(api.fetchCompanyList).toHaveBeenCalledWith(null, 15, null);
  });
});
