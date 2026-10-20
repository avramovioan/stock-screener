import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPortfolio } from "./portfolio-api";
import { RefreshablePage, RefreshBar } from "./refresh-bar";

vi.mock("./default", () => ({ portfolioApi: { get: vi.fn(), refresh: vi.fn() } }));
const manualRefresh = vi.fn();
vi.mock("./use-manual-refresh", () => ({ useManualRefresh: () => manualState }));
let manualState = {
  refresh: manualRefresh,
  secondsLeft: 0,
  available: true,
  refreshing: false,
  error: null as string | null,
};

const startSync = vi.fn();
vi.mock("./use-statement-sync", () => ({ useStatementSync: () => syncState }));
let syncState = {
  start: startSync,
  active: false,
  syncedAt: null as number | null,
  nextAt: null as number | null,
  nextNotice: null as string | null,
};

const NOW = new Date("2026-10-15T07:00:00.000Z");
const data = (over: Partial<ClientPortfolio> = {}): ClientPortfolio =>
  ({
    serverTime: NOW.toISOString(),
    nextAutoRefreshAt: new Date(NOW.getTime() + 272_000).toISOString(),
    manualAvailableAt: NOW.toISOString(),
    lastSuccessfulAt: "2026-10-15T06:58:00.000Z",
    reportDate: "2026-10-14",
    lastStatementDate: "2026-10-14",
    syncQueued: false,
    quoteError: null,
    statement: { expectedDate: "2026-10-14", freshness: { kind: "current" } },
    receivedAtMs: NOW.getTime(),
    view: { positions: [] },
    ...over,
  }) as never;

const props = (over: Partial<Parameters<typeof RefreshBar>[0]> = {}) => ({
  data: data(),
  error: null,
  fetching: false,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  manualState = {
    refresh: manualRefresh,
    secondsLeft: 0,
    available: true,
    refreshing: false,
    error: null,
  };
  manualRefresh.mockReset();
  startSync.mockReset();
  syncState = { start: startSync, active: false, syncedAt: null, nextAt: null, nextNotice: null };
});
afterEach(() => vi.useRealTimers());

describe("RefreshBar", () => {
  it("states the statement date and the delayed-quote time plainly", () => {
    render(<RefreshBar {...props()} />);
    expect(
      screen.getByText(
        "Positions from the IBKR statement of 14 Oct 2026 · Prices: delayed quotes as of 15 Oct 2026, 09:58 (15–20 min)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "IBKR produces statements once a day after the close; today's trades appear in tomorrow's statement.",
      ),
    ).toBeTruthy();
  });

  it("when quotes are unavailable the prices are the statement close", () => {
    render(<RefreshBar {...props({ data: data({ quoteError: "quote_provider_unavailable" }) })} />);
    expect(
      screen.getByText(
        "Positions from the IBKR statement of 14 Oct 2026 · Prices: statement close of 14 Oct 2026",
      ),
    ).toBeTruthy();
  });

  it("before the first statement it says there is none", () => {
    render(
      <RefreshBar
        {...props({ data: data({ reportDate: null, lastSuccessfulAt: null, quoteError: null }) })}
      />,
    );
    expect(screen.getByText("No statement yet")).toBeTruthy();
  });

  it("Sync statement now starts a statement sync", () => {
    render(<RefreshBar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync statement now" }));
    expect(startSync).toHaveBeenCalledTimes(1);
  });

  it("while a statement run is active the button reads Syncing statement… and is disabled", () => {
    syncState = { ...syncState, active: true };
    render(<RefreshBar {...props()} />);
    const button = screen.getByRole("button", { name: "Syncing statement…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(startSync).not.toHaveBeenCalled();
  });

  it("after a sync the time is announced politely", () => {
    syncState = { ...syncState, syncedAt: NOW.getTime() };
    render(<RefreshBar {...props()} />);
    const live = screen.getByTestId("statement-announcement");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toMatch(/^Statement synced at /);
  });

  it("after the cooldown answer the button title says when the next sync is possible", () => {
    syncState = {
      ...syncState,
      nextAt: NOW.getTime() + 540_000,
      nextNotice: "Statement synced recently; next at 10:09",
    };
    render(<RefreshBar {...props()} />);
    expect(screen.getByRole("button", { name: "Sync statement now" }).getAttribute("title")).toBe(
      "Statement synced recently; next at 10:09",
    );
  });

  it("a statement that is behind says so with the number of days and never calls itself today's", () => {
    render(
      <RefreshBar
        {...props({
          data: data({
            statement: {
              expectedDate: "2026-10-14",
              freshness: { kind: "behind", days: 3 },
            } as never,
            reportDate: "2026-10-11",
          }),
        })}
      />,
    );
    expect(screen.getByText(/The statement is 3 days behind the expected date/)).toBeTruthy();
    expect(screen.queryByText(/today's positions/i)).toBeNull();
  });

  it("shows the last successful refresh in Sofia time and the countdown to the next automatic refresh", () => {
    render(<RefreshBar {...props()} />);
    expect(screen.getByText(/Last successful refresh: 15 Oct 2026, 09:58/)).toBeTruthy();
    expect(screen.getByText(/Next automatic refresh in 4:32/)).toBeTruthy();
  });

  it("the Refresh quotes button calls the manual refresh; during the cooldown it is disabled and shows the countdown", () => {
    const { rerender } = render(<RefreshBar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh quotes" }));
    expect(manualRefresh).toHaveBeenCalledTimes(1);
    manualState = { ...manualState, secondsLeft: 42, available: false };
    rerender(<RefreshBar {...props()} />);
    const button = screen.getByRole("button", { name: /Refresh quotes in 0:42/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(manualRefresh).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh shows the error and the time of the data still on screen, never a blank", () => {
    render(
      <RefreshBar {...props({ error: new Error("Network error: could not reach the server.") })} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Network error: could not reach the server.");
    expect(alert.textContent).toContain("Showing the data from 15 Oct 2026, 09:58");
  });

  it("a quote problem is reported while the statement prices stay visible", () => {
    render(
      <RefreshBar
        {...props({
          data: data({ quoteError: "quote_provider_unavailable", lastSuccessfulAt: null }),
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Delayed quotes are unavailable");
    expect(screen.getByText(/Last successful refresh: none yet/)).toBeTruthy();
  });

  it("the manual refresh error from the hook is shown too", () => {
    manualState = { ...manualState, error: "The refresh failed (HTTP 500)." };
    render(<RefreshBar {...props()} />);
    expect(screen.getByRole("alert").textContent).toContain("The refresh failed (HTTP 500).");
  });

  it("a pull anywhere on the page (outside the status panel) triggers the refresh", () => {
    render(
      <RefreshablePage enabled>
        <p>Page content far from the status panel</p>
        <RefreshBar {...props()} />
      </RefreshablePage>,
    );
    const area = screen.getByTestId("pull-area");
    const touch = (y: number) => ({ touches: [{ clientY: y }], changedTouches: [{ clientY: y }] });
    fireEvent.touchStart(screen.getByText("Page content far from the status panel"), touch(100));
    fireEvent.touchMove(area, touch(190));
    fireEvent.touchEnd(area, touch(190));
    expect(manualRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("pull-area")).toHaveLength(1);
  });

  it("a pull does nothing while there is no portfolio yet", () => {
    render(
      <RefreshablePage enabled={false}>
        <p>Loading</p>
      </RefreshablePage>,
    );
    const area = screen.getByTestId("pull-area");
    const touch = (y: number) => ({ touches: [{ clientY: y }], changedTouches: [{ clientY: y }] });
    fireEvent.touchStart(area, touch(100));
    fireEvent.touchEnd(area, touch(190));
    expect(manualRefresh).not.toHaveBeenCalled();
  });

  it("a successful refresh is announced in a polite live region", () => {
    manualState = { ...manualState, succeededAt: NOW.getTime() } as typeof manualState;
    render(
      <RefreshablePage enabled>
        <RefreshBar {...props()} />
      </RefreshablePage>,
    );
    const live = screen.getByTestId("refresh-announcement");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toMatch(/^Data refreshed at /);
  });
});
