import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const q = vi.hoisted(() => ({ searchSymbols: vi.fn() }));
vi.mock("@/features/screening/quotes-api", () => ({
  ...q,
  fetchQuotes: vi.fn(),
  fetchChartBySymbol: vi.fn(),
}));

import { StockSelect, SymbolSearch } from "./stock-selector";

const options = [
  makeDiscount({
    rank: 53,
    yahoo_symbol: "MSFT",
    name: "Microsoft Corporation",
    security_id: "sid-msft",
  }),
  makeDiscount({
    rank: 12,
    yahoo_symbol: "ASML.AS",
    name: "ASML Holding",
    security_id: "sid-asml",
    exchange_code: "AMS",
  }),
];
const hit = {
  symbol: "NVDA",
  exchange: "NMS",
  quoteType: "EQUITY",
  longName: "NVIDIA Corporation",
  shortName: "NVIDIA",
};

beforeEach(() => q.searchSymbols.mockReset().mockResolvedValue([hit]));
afterEach(cleanup);

describe("StockSelect", () => {
  it("is labelled 'Select a stock from today' and lists #rank TICKER — Company", () => {
    renderWithProviders(<StockSelect options={options} symbol="MSFT" onSelect={() => undefined} />);
    return screen.findByLabelText("Select a stock from today").then((select) => {
      const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
      expect(labels).toContain("#53 MSFT — Microsoft Corporation");
      expect(labels).toContain("#12 ASML — ASML Holding");
      expect((select as HTMLSelectElement).value).toBe("MSFT");
    });
  });
  it("choosing an option reports that selection explicitly", async () => {
    const onSelect = vi.fn();
    renderWithProviders(<StockSelect options={options} symbol="MSFT" onSelect={onSelect} />);
    const select = await screen.findByLabelText("Select a stock from today");
    fireEvent.change(select, { target: { value: "ASML.AS" } });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ASML.AS", securityId: "sid-asml" }),
    );
  });
  it("a searched security outside the list is shown, not silently replaced", async () => {
    renderWithProviders(<StockSelect options={options} symbol="NVDA" onSelect={() => undefined} />);
    const select = (await screen.findByLabelText("Select a stock from today")) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).some((o) => o.textContent?.includes("NVDA"))).toBe(true);
  });
});

describe("SymbolSearch", () => {
  it("typing never selects; it debounces 300 ms and needs 2 characters", async () => {
    const onPick = vi.fn();
    renderWithProviders(<SymbolSearch onPick={onPick} />);
    const input = await screen.findByLabelText("Search for a security");
    fireEvent.change(input, { target: { value: "n" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(q.searchSymbols).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "nv" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(q.searchSymbols).not.toHaveBeenCalled();
    await waitFor(() => expect(q.searchSymbols).toHaveBeenCalledWith("nv"));
    expect(await screen.findByText(/NVDA/)).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });
  it("picking a result is an explicit action and clears the box", async () => {
    const onPick = vi.fn();
    renderWithProviders(<SymbolSearch onPick={onPick} />);
    const input = (await screen.findByLabelText("Search for a security")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nvidia" } });
    const button = await screen.findByRole("button", { name: /NVDA/ });
    fireEvent.click(button);
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NVDA", exchangeCode: "NMS", securityId: null }),
    );
    expect(input.value).toBe("");
  });
  it("says so when nothing matches", async () => {
    q.searchSymbols.mockResolvedValue([]);
    renderWithProviders(<SymbolSearch onPick={() => undefined} />);
    fireEvent.change(await screen.findByLabelText("Search for a security"), {
      target: { value: "zzzz" },
    });
    expect(await screen.findByText("No matches")).toBeTruthy();
  });
});
