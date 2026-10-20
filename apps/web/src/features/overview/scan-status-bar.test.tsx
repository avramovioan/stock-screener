import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScanStatus } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const api = vi.hoisted(() => ({ fetchScanStatus: vi.fn() }));
vi.mock("@/features/screening/api", () => ({
  ...api,
  fetchTodaysDiscounts: vi.fn(),
  fetchCompanyList: vi.fn(),
  fetchShortSummary: vi.fn(),
  fetchPriceSeries: vi.fn(),
}));

import { ScanBanner, ScanStatusBar } from "./scan-status-bar";

beforeEach(() => api.fetchScanStatus.mockReset());
afterEach(cleanup);

describe("ScanStatusBar", () => {
  it("shows the last SUCCESSFUL scan as Mon D, HH:mm Sofia time", async () => {
    api.fetchScanStatus.mockResolvedValue(makeScanStatus());
    renderWithProviders(<ScanStatusBar />);
    expect(await screen.findByText("Last scan Oct 15, 10:41 Sofia time")).toBeTruthy();
  });
  it("shows the published time when the run was partial and no run completed", async () => {
    api.fetchScanStatus.mockResolvedValue(
      makeScanStatus({
        last_successful: null,
        latest_published: {
          ...makeScanStatus().latest_published!,
          status: "partial",
          results_published_at: "2026-10-15T07:41:00Z",
        },
      }),
    );
    renderWithProviders(<ScanStatusBar />);
    expect(await screen.findByText("Last scan Oct 15, 10:41 Sofia time")).toBeTruthy();
  });
  it("never shows an attempt time as a success time", async () => {
    api.fetchScanStatus.mockResolvedValue(
      makeScanStatus({
        last_successful: null,
        last_attempted: {
          scan_date_local: "2026-10-15",
          started_at: "2026-10-15T07:00:00Z",
          status: "failed",
        },
        latest_published: null,
      }),
    );
    renderWithProviders(<ScanStatusBar />);
    expect(await screen.findByText("No scan published yet")).toBeTruthy();
    expect(screen.queryByText(/Last scan/)).toBeNull();
  });
  it("renders a failed-scan banner via ScanBanner", async () => {
    api.fetchScanStatus.mockResolvedValue(
      makeScanStatus({
        last_attempted: {
          scan_date_local: "2026-10-15",
          started_at: "2026-10-15T09:00:00Z",
          status: "failed",
        },
      }),
    );
    renderWithProviders(<ScanBanner />);
    expect((await screen.findByTestId("banner-failed")).textContent).toContain(
      "Latest scan failed: 612 of 612 securities processed",
    );
  });
});
