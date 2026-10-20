import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HoldingLink } from "./holdings-api";
import { PositionsTable } from "./positions-table";
import { makeRow, makeView, SHEL } from "./test-fixtures";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/research/r-1">{children}</a>,
}));
vi.mock("@/features/handoff/trade-on-ibkr-button", () => ({
  TradeOnIbkrButton: ({ className }: { className?: string }) => (
    <button type="button" data-testid="trade-on-ibkr-button" className={className}>
      Trade on IBKR
    </button>
  ),
}));

const view = makeView();
const aapl: HoldingLink = {
  conid: 100001,
  securityId: "sec-aapl",
  symbol: "AAPL",
  monitor: { reportId: "r-1", fullReportDate: "2026-10-01", lastCheckDate: "2026-10-14" },
  held: {
    symbol: "AAPL",
    listingExchange: "IBIS",
    conid: 100001,
    description: "APPLE INC",
    currency: "EUR",
  },
  isin: "US0378331005",
  screened: { exchangeCode: "NMS", exchangeName: "NASDAQ", rank: 4 },
};
const etf: HoldingLink = {
  conid: 100002,
  securityId: null,
  symbol: null,
  monitor: null,
  held: {
    symbol: "VUAA",
    listingExchange: "LSEETF",
    conid: 100002,
    description: "VANG S&amp;P500 USDD",
    currency: "USD",
  },
  isin: null,
};

function mount(
  rows = [makeRow(), SHEL({ conid: 100002, ticker: "VUAA", name: "VANG S&amp;P500 USDD" })],
) {
  render(
    <PositionsTable
      rows={rows}
      totals={view.totals}
      perCurrency={view.perCurrency}
      base="EUR"
      links={
        new Map([
          [100001, aapl],
          [100002, etf],
        ])
      }
    />,
  );
  return screen.getByTestId("positions-cards");
}

describe("phone holding card", () => {
  it("a screened holding: ticker, tag, name, shares and price, value, P&L with today's change", () => {
    const card = within(mount()).getByTestId("card-AAPL");
    expect(within(card).getByTestId("card-ticker").className).toContain("text-xl");
    expect(within(card).getByText("APPLE INC").className).toContain("truncate");
    expect(within(card).getByText("10 shares · 232.00 USD")).toBeTruthy();
    expect(within(card).getByText("2,320.00 USD")).toBeTruthy();
    expect(within(card).getByText("+318.30 USD")).toBeTruthy();
    expect(within(card).getByText("+22.97 USD today")).toBeTruthy();
    const tag = within(card).getByText("Within channel");
    expect(tag.closest("[data-tone]")?.getAttribute("data-tone")).toBe("grey");
  });

  it("an unscreened holding carries the grey Not screened tag and a decoded name", () => {
    const card = within(mount()).getByTestId("card-VUAA");
    const tag = within(card).getByText("Not screened");
    expect(tag.closest("[data-tone]")?.getAttribute("data-tone")).toBe("grey");
    expect(within(card).getByText("VANG S&P500 USDD")).toBeTruthy();
    expect(within(card).getByText("100 shares · 24.31 GBP")).toBeTruthy();
  });

  it("a premium holding keeps its valuation tag", () => {
    const card = within(mount([makeRow({ tag: "premium" })])).getByTestId("card-AAPL");
    expect(within(card).getByTestId("valuation-premium")).toBeTruthy();
    expect(within(card).queryByText("Within channel")).toBeNull();
  });

  it("says 1 share and price unavailable", () => {
    const row = makeRow({
      quantity: 1,
      price: {
        value: null,
        ccy: "USD",
        source: { kind: "unavailable", reason: "no quote" },
        note: null,
      },
    });
    const card = within(mount([row])).getByTestId("card-AAPL");
    expect(within(card).getByText("1 share · price unavailable")).toBeTruthy();
  });

  it("has no info buttons inside a card", () => {
    const cards = mount();
    for (const c of within(cards).getAllByRole("listitem"))
      expect(within(c).queryByRole("button", { name: /^(About|Price details)/ })).toBeNull();
  });

  it("the actions row: Trade fills the row, icon buttons are 44 px", () => {
    const card = within(mount()).getByTestId("card-AAPL");
    const trade = within(card).getByTestId("trade-on-ibkr-button");
    expect(trade.className).toContain("flex-1");
    expect(trade.className).toContain("min-h-11");
    expect(
      within(card).getByRole("button", { name: "Re-evaluate AAPL against today's channel" })
        .className,
    ).toContain("max-md:size-11");
  });

  it("Details toggles the facts in place", () => {
    const card = within(mount()).getByTestId("card-AAPL");
    const toggle = within(card).getByRole("button", { name: /Details/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(card).queryByText("Held as")).toBeNull();
    fireEvent.click(toggle);
    const open = within(card).getByRole("button", { name: /Hide details/ });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(open.getAttribute("aria-controls") ?? "");
    const text = panel?.textContent ?? "";
    expect(text).toContain("Held asAAPL on Xetra (IBIS), EUR");
    expect(text).toContain("ISINUS0378331005");
    expect(text).toContain("Screened asAAPL on NASDAQ · rank 4");
    expect(text).toContain("Avg cost200.17 USD");
    expect(text).toContain("Cost basis2,001.70 USD, broker-reported");
    expect(text).toContain("PriceDelayed quote");
    expect(text).toContain("IBKR P&L+298.30 USD FIFO at the statement close · reconciles");
    expect(text).toContain("Valuationbased on close of 2026-10-14");
    expect(text).toContain("Full report: 2026-10-01");
    expect(within(card).getByRole("link", { name: /Open full report/ })).toBeTruthy();
    fireEvent.click(open);
    expect(within(card).queryByText("Held as")).toBeNull();
  });

  it("IBKR P&L says just not reported when the broker figure is missing", () => {
    const card = within(mount([makeRow({ unrealizedBroker: null, reconciles: null })])).getByTestId(
      "card-AAPL",
    );
    fireEvent.click(within(card).getByRole("button", { name: /Details/ }));
    expect(card.textContent).toContain("IBKR P&Lnot reported");
    expect(card.textContent).not.toContain("FIFO");
  });

  it("an unscreened holding's facts say so and have no ISIN or research row", () => {
    const card = within(mount()).getByTestId("card-VUAA");
    fireEvent.click(within(card).getByRole("button", { name: /Details/ }));
    const text = card.textContent ?? "";
    expect(text).toContain("VUAA on LSEETF, USD");
    expect(text).toContain("Not a screened company");
    expect(text).not.toContain("ISIN");
    expect(text).not.toContain("Research");
  });
});

describe("phone sort row and About box", () => {
  it("labels the direction button High first / Low first for numbers, A to Z / Z to A for text", () => {
    const cards = mount();
    const select = within(cards).getByLabelText("Sort");
    fireEvent.change(select, { target: { value: "value" } });
    expect(within(cards).getByRole("button", { name: /Low first/ })).toBeTruthy();
    fireEvent.click(within(cards).getByRole("button", { name: /Low first/ }));
    expect(within(cards).getByRole("button", { name: /High first/ })).toBeTruthy();
    fireEvent.change(select, { target: { value: "ticker" } });
    expect(within(cards).getByRole("button", { name: /A to Z/ })).toBeTruthy();
    fireEvent.click(within(cards).getByRole("button", { name: /A to Z/ }));
    expect(within(cards).getByRole("button", { name: /Z to A/ })).toBeTruthy();
    fireEvent.change(select, { target: { value: "tag" } });
    expect(within(cards).getByRole("button", { name: /A to Z/ })).toBeTruthy();
  });

  it("About these numbers explains price, value, P&L and valuation", () => {
    const cards = mount();
    fireEvent.click(within(cards).getByRole("button", { name: "About these numbers" }));
    const box = screen.getByRole("dialog", { name: "About these numbers" });
    for (const t of ["Price", "Value", "P&L", "Valuation"])
      expect(within(box).getByText(t).tagName).toBe("STRONG");
    expect(box.textContent).toContain("delayed quote");
    expect(box.textContent).toContain("Each card's Details shows that line's source and time.");
    expect(box.textContent).not.toContain("The ⓘ in a price cell");
    expect(box.textContent).toContain("Discounted");
  });
});
