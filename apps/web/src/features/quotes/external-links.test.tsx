import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalLinks } from "./external-links";

afterEach(cleanup);

describe("ExternalLinks", () => {
  it("renders both underlined links for the same listing, opening safely", () => {
    render(<ExternalLinks exchangeCode="NMS" symbol="MSFT" />);
    const tv = screen.getByRole("link", { name: "View on TradingView" }) as HTMLAnchorElement;
    const yh = screen.getByRole("link", { name: "View on Yahoo Finance" }) as HTMLAnchorElement;
    expect(tv.getAttribute("href")).toBe("https://www.tradingview.com/symbols/NASDAQ-MSFT/");
    expect(yh.getAttribute("href")).toBe("https://finance.yahoo.com/quote/MSFT/");
    for (const a of [tv, yh]) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.className).toContain("underline");
    }
    expect(screen.queryByText(/unverified/i)).toBeNull();
  });
  it("flags an unverified mapping but still links", () => {
    render(<ExternalLinks exchangeCode="NYQ" symbol="BRK-B" />);
    expect(
      (screen.getByRole("link", { name: "View on TradingView" }) as HTMLAnchorElement).getAttribute(
        "href",
      ),
    ).toBe("https://www.tradingview.com/symbols/NYSE-BRK.B/");
    expect(screen.getByText(/unverified mapping/i)).toBeTruthy();
  });
  it("without a TradingView mapping shows plain text with the note, Yahoo still links", () => {
    render(<ExternalLinks exchangeCode="XXX" symbol="ABC.XX" />);
    expect(screen.queryByRole("link", { name: "View on TradingView" })).toBeNull();
    expect(screen.getByText("View on TradingView")).toBeTruthy();
    expect(screen.getByText(/no TradingView mapping for this exchange/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View on Yahoo Finance" })).toBeTruthy();
  });
  it("an unknown exchange (null) behaves like no mapping", () => {
    render(<ExternalLinks exchangeCode={null} symbol="ABC" />);
    expect(screen.getByText(/no TradingView mapping for this exchange/i)).toBeTruthy();
  });
});
