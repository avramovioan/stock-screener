import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { makeResponse, makeView, na } from "../portfolio/page/test-fixtures";
import { NotLinkedError } from "../portfolio/portfolio-api";
import { makeData } from "./test-fixtures";

const get = vi.fn();
const load = vi.fn();
vi.mock("@/features/portfolio/default", () => ({
  portfolioApi: { get: (...a: unknown[]) => get(...a), refresh: vi.fn() },
}));
vi.mock("@/features/analytics/default", () => ({
  analyticsApi: { load: (...a: unknown[]) => load(...a) },
}));
const createChart = vi.fn(() => ({
  addSeries: () => ({ setData: vi.fn() }),
  timeScale: () => ({ fitContent: vi.fn() }),
  remove: vi.fn(),
}));
vi.mock("lightweight-charts", () => ({
  createChart: (...a: unknown[]) => (createChart as (...x: unknown[]) => unknown)(...a),
  LineSeries: "line-series",
}));

beforeEach(() => {
  get.mockReset();
  load.mockReset();
  createChart.mockClear();
  get.mockResolvedValue(makeResponse());
  load.mockResolvedValue(makeData());
});

const card = (name: string) => screen.getByRole("article", { name });

describe("AnalyticsPage", () => {
  it("not linked: the link prompt with a button to Profile -> Broker", async () => {
    get.mockRejectedValue(new NotLinkedError());
    await renderApp("/analytics", signedIn());
    expect(await screen.findByText("No broker is linked")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Link your broker" }).getAttribute("href")).toBe(
      "/profile/broker",
    );
  });

  it("shows every figure with its origin: broker-reported or calculated by this app", async () => {
    await renderApp("/analytics", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Analytics" })).toBeTruthy();
    const total = await screen.findByRole("article", { name: "Total portfolio value" });
    expect(within(total).getByText("9,950.20 EUR")).toBeTruthy();
    expect(within(total).getByText("4,977.56 EUR")).toBeTruthy();
    for (const name of [
      "Total portfolio value",
      "Cost basis of current positions",
      "Unrealized P&L",
      "Realized trading P&L",
      "Dividends",
      "Commissions and other costs",
      "Combined performance",
      "Historical performance",
    ]) {
      const c = card(name);
      expect(
        within(c).queryByTestId("provenance-broker") !== null ||
          within(c).queryByTestId("provenance-calculated") !== null,
      ).toBe(true);
    }
    expect(within(card("Combined performance")).getByTestId("provenance-calculated")).toBeTruthy();
    expect(within(card("Realized trading P&L")).getByTestId("provenance-broker")).toBeTruthy();
  });

  it("unrealized P&L: calculated (current prices) and broker FIFO side by side; realized from the closed lots of the partial sale", async () => {
    await renderApp("/analytics", signedIn());
    const unrealized = await screen.findByRole("article", { name: "Unrealized P&L" });
    expect(within(unrealized).getByText("+215.98 EUR")).toBeTruthy();
    expect(within(unrealized).getByText(/Broker FIFO at the statement close/)).toBeTruthy();
    const realized = card("Realized trading P&L");
    expect(within(realized).getByText("+5.29 EUR")).toBeTruthy();
    expect(within(realized).getByText(/2 closed lots/)).toBeTruthy();
    expect(
      within(realized).getByText(
        /Commissions are already netted by IBKR and are not subtracted again/,
      ),
    ).toBeTruthy();
  });

  it("dividends gross, withholding and net, and the commission memo versus other costs", async () => {
    await renderApp("/analytics", signedIn());
    const div = await screen.findByRole("article", { name: "Dividends" });
    expect(within(div).getByText("Gross")).toBeTruthy();
    expect(within(div).getByText("2.39 EUR")).toBeTruthy();
    expect(within(div).getByText("-0.36 EUR")).toBeTruthy();
    expect(within(div).getByText("+2.03 EUR")).toBeTruthy();
    const costs = card("Commissions and other costs");
    expect(within(costs).getByText(/already inside the realized P&L/)).toBeTruthy();
    expect(within(costs).getByText("2.02 EUR")).toBeTruthy();
    expect(within(costs).getByText("2.00 EUR")).toBeTruthy();
  });

  it("the toggle includes the net dividends in the combined figure and the label says which it is", async () => {
    await renderApp("/analytics", signedIn());
    const combined = await screen.findByRole("article", { name: "Combined performance" });
    expect(within(combined).getByText("+221.27 EUR")).toBeTruthy();
    expect(within(combined).getByText(/dividends excluded/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("switch", { name: "Include net dividends in combined performance" }),
    );
    await waitFor(() =>
      expect(within(card("Combined performance")).getByText("+223.30 EUR")).toBeTruthy(),
    );
    expect(within(card("Combined performance")).getByText(/dividends included/i)).toBeTruthy();
    expect(within(card("Combined performance")).getByText("+221.30 EUR")).toBeTruthy(); // after other costs
  });

  it("the coverage disclosure states the loaded period", async () => {
    await renderApp("/analytics", signedIn());
    expect(
      await screen.findByText(
        "History loaded from 15 Oct 2025 to 14 Oct 2026 — earlier activity is not included. Realized P&L may be incomplete before 15 Oct 2025.",
      ),
    ).toBeTruthy();
  });

  it("an unavailable input makes the combined figure a dash with the reason, never 0", async () => {
    get.mockResolvedValue(
      makeResponse({
        view: makeView(undefined, {
          totals: { ...makeView().totals, unrealizedBase: na("Missing FX rate USD->EUR") },
        }),
      }),
    );
    await renderApp("/analytics", signedIn());
    const combined = await screen.findByRole("article", { name: "Combined performance" });
    expect(
      within(combined).getAllByText("Unavailable: Missing FX rate USD->EUR").length,
    ).toBeGreaterThan(0);
    expect(within(combined).queryByText(/^\+?0\.00 EUR/)).toBeNull();
  });

  it("per-currency breakdown and the NAV chart (two rows) are shown", async () => {
    await renderApp("/analytics", signedIn());
    expect(await screen.findByRole("table", { name: /Per-currency breakdown/ })).toBeTruthy();
    await waitFor(() => expect(createChart).toHaveBeenCalled());
    expect(screen.getByRole("table", { name: "NAV history (data)" })).toBeTruthy();
  });

  it("with fewer than two NAV rows the chart says so", async () => {
    load.mockResolvedValue(makeData({ nav: [{ date: "2026-10-14", total: 9950.2, ccy: "EUR" }] }));
    await renderApp("/analytics", signedIn());
    expect(
      await screen.findByText(
        "Not enough NAV history yet: a line needs at least two statement days.",
      ),
    ).toBeTruthy();
    expect(createChart).not.toHaveBeenCalled();
  });

  it("transfers that are not valued make the historical performance unavailable with a reason", async () => {
    load.mockResolvedValue(makeData({ hasUnvaluedTransfers: true }));
    await renderApp("/analytics", signedIn());
    const hist = await screen.findByRole("article", { name: "Historical performance" });
    expect(
      within(hist).getByText("Unavailable: Transfers or other flows are not valued"),
    ).toBeTruthy();
  });

  it("history failing to load shows an error with Retry while the refresh bar stays", async () => {
    load.mockRejectedValue(new Error("Could not load the statement history."));
    await renderApp("/analytics", signedIn());
    expect(
      await screen.findByText("Could not load the statement history.", {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByLabelText("Refresh status")).toBeTruthy();
  });

  it("a failed portfolio refresh keeps the figures and shows the error banner", async () => {
    const { queryClient } = await renderApp("/analytics", signedIn());
    await screen.findByRole("article", { name: "Combined performance" });
    get.mockRejectedValue(new Error("Network error: could not reach the server."));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["portfolio"] }).catch(() => undefined);
    });
    await waitFor(
      () =>
        expect(screen.getByRole("alert").textContent).toContain(
          "Network error: could not reach the server.",
        ),
      { timeout: 4000 },
    );
    expect(card("Combined performance")).toBeTruthy();
  });
});
