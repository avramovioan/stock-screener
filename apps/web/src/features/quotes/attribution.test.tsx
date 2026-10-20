import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AttributionNotice, LWC_NOTICE, TRADINGVIEW_URL } from "./attribution";

afterEach(cleanup);

describe("AttributionNotice", () => {
  it("shows the NOTICE text and a link to tradingview.com that opens safely", () => {
    render(<AttributionNotice />);
    expect(LWC_NOTICE).toContain("TradingView, Inc.");
    expect(LWC_NOTICE).toContain("Copyright");
    expect(screen.getByText(/TradingView Lightweight Charts/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /tradingview\.com/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(TRADINGVIEW_URL);
    expect(TRADINGVIEW_URL).toBe("https://www.tradingview.com/");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
