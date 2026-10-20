import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { NotLinkedError, RefreshFailure } from "../portfolio-api";
import { makeResponse, makeRow, makeView, NOPX, SHEL } from "./test-fixtures";

const get = vi.fn();
const refresh = vi.fn();
vi.mock("@/features/portfolio/default", () => ({
  portfolioApi: {
    get: (...a: unknown[]) => get(...a),
    refresh: (...a: unknown[]) => refresh(...a),
  },
}));
vi.mock("@/features/broker/default", () => ({
  brokerApi: {
    readSnapshot: () => Promise.resolve({ connection: null, run: null }),
    sync: () => Promise.resolve({ ok: false, kind: "not_linked" }),
  },
}));
vi.mock("@/features/portfolio/page/trades-default", () => ({
  tradesApi: { page: () => Promise.resolve({ rows: [], total: 0 }) },
}));
vi.mock("@/features/portfolio/page/holdings-default", () => ({
  holdingsApi: {
    links: () =>
      Promise.resolve(
        new Map([
          [
            100001,
            {
              conid: 100001,
              securityId: "sec-aapl",
              symbol: "AAPL",
              monitor: {
                reportId: "r-1",
                fullReportDate: "2026-10-01",
                lastCheckDate: "2026-10-14",
              },
            },
          ],
        ]),
      ),
  },
}));

beforeEach(() => {
  get.mockReset();
  refresh.mockReset();
});

describe("PortfolioPage", () => {
  it("not linked: a short explanation and a button to Profile -> Broker", async () => {
    get.mockRejectedValue(new NotLinkedError());
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByText("No broker is linked")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Link your broker" });
    expect(link.getAttribute("href")).toBe("/profile/broker");
  });

  it("shows the header with the T+1 disclosure, the summary, the positions in default order and the trade history section", async () => {
    get.mockResolvedValue(makeResponse());
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeTruthy();
    expect(
      await screen.findByText(/Positions from the IBKR statement of 14 Oct 2026/),
    ).toBeTruthy();
    expect(screen.getByText(/IBKR produces statements once a day after the close/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh quotes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync statement now" })).toBeTruthy();
    const table = await screen.findByTestId("positions-table");
    expect(
      within(table)
        .getAllByTestId("row-ticker")
        .map((e) => e.textContent),
    ).toEqual(["SHEL", "AAPL", "NOPX"]);
    expect(screen.getByRole("region", { name: "Portfolio summary" })).toBeTruthy();
    expect(await screen.findByText("No executions in the loaded statements.")).toBeTruthy();
  });

  it("mounts the monitored-holding research block only for the monitored position", async () => {
    get.mockResolvedValue(makeResponse());
    await renderApp("/portfolio", signedIn());
    const table = await screen.findByTestId("positions-table");
    fireEvent.click(await within(table).findByRole("button", { name: "About AAPL" }));
    const block = await screen.findByTestId("holding-research-AAPL");
    expect(
      within(block).getByText(/Full report: 2026-10-01 · Last change check: 2026-10-14/),
    ).toBeTruthy();
    expect(screen.queryByTestId("holding-research-SHEL")).toBeNull();
  });

  it("a behind statement is flagged and the page never calls it today's positions", async () => {
    get.mockResolvedValue(
      makeResponse({
        statement: { expectedDate: "2026-10-14", freshness: { kind: "behind", days: 2 } } as never,
        reportDate: "2026-10-12",
      }),
    );
    await renderApp("/portfolio", signedIn());
    expect(
      await screen.findByText(/The statement is 2 days behind the expected date/),
    ).toBeTruthy();
    expect(screen.queryByText(/today's positions/i)).toBeNull();
  });

  it("an empty portfolio shows the explanation, not an empty table or zeros", async () => {
    get.mockResolvedValue(makeResponse({ view: makeView([]) }));
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByText("No open positions in the latest statement.")).toBeTruthy();
  });

  it("a failed refresh keeps the last successful table on screen and shows the error banner", async () => {
    get.mockResolvedValueOnce(makeResponse({ view: makeView([makeRow(), SHEL(), NOPX()]) }));
    get.mockRejectedValue(new RefreshFailure(null, "Network error: could not reach the server."));
    const { queryClient } = await renderApp("/portfolio", signedIn());
    await screen.findByTestId("positions-table");
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
    expect(screen.getByTestId("positions-table")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Showing the data from 15 Oct 2026, 10:00",
    );
  });

  it("the first load failing shows an error with Retry, never a blank page", async () => {
    get.mockRejectedValue(new RefreshFailure(500, "The refresh failed (HTTP 500)."));
    await renderApp("/portfolio", signedIn());
    // the query retries once after one second before it reports the failure
    expect(
      await screen.findByText("The refresh failed (HTTP 500).", {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows a loading skeleton first", async () => {
    get.mockReturnValue(new Promise(() => undefined));
    await renderApp("/portfolio", signedIn());
    expect((await screen.findAllByRole("status")).length).toBeGreaterThan(0);
  });
});
