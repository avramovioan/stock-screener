import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { AboutPage } from "./about-page";

afterEach(cleanup);

describe("AboutPage", () => {
  it("explains what the site does and its limits", async () => {
    renderWithProviders(<AboutPage />, { path: "/about" });
    expect(await screen.findByRole("heading", { level: 1, name: "About" })).toBeTruthy();
    expect(screen.getByText(/Yahoo Finance delayed data/)).toBeTruthy();
    expect(
      screen.getByText(/AI research generated from public sources, not financial advice/),
    ).toBeTruthy();
    expect(screen.getByText(/never labelled live/i)).toBeTruthy();
  });
  it("names the infrastructure and carries the TradingView attribution with its link", async () => {
    renderWithProviders(<AboutPage />, { path: "/about" });
    await screen.findByRole("heading", { level: 1, name: "About" });
    expect(screen.getByText(/Supabase/)).toBeTruthy();
    expect(screen.getByText(/Cloudflare/)).toBeTruthy();
    expect(screen.getByText(/TradingView Lightweight Charts/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /tradingview\.com/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.tradingview.com/");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("describes the scan timestamp and the channel indicator", async () => {
    renderWithProviders(<AboutPage />, { path: "/about" });
    await screen.findByRole("heading", { level: 1, name: "About" });
    expect(screen.getByText(/Last successful scan/)).toBeTruthy();
    expect(screen.getByText(/2,500/)).toBeTruthy();
  });
});
