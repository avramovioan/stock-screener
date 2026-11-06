import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/features/screening/errors";
import type { RegulatedResult } from "./regulated-api";
import { VALID_ISIN } from "./test-fixtures";

vi.mock("@core/eu-exchanges.ts", async () => {
  const { FIXTURE_EXCHANGES: list } = await import("./test-fixtures");
  return {
    EU_EXCHANGES: list,
    findEuExchange: (mic: string) => list.find((e) => e.mic === mic),
  };
});
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
}));
vi.mock("./regulated-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./regulated-api")>()),
  checkRegulated: vi.fn(),
}));

import { checkRegulated, EsmaUnavailableError } from "./regulated-api";
import { RegulatedPage } from "./regulated-page";

const check = vi.mocked(checkRegulated);

const base: RegulatedResult = {
  isin: VALID_ISIN,
  mic: "XETR",
  exchangeName: "Deutsche Börse Xetra",
  verdict: "regulated",
  source: "solr",
  matchedSegment: { mic: "XETA", name: "Xetra" },
  instrumentName: "iShares Core MSCI World",
  regulatedSegments: [{ mic: "XETA", name: "Xetra" }],
  checkedSegments: ["XETA"],
  checkedAt: "2026-11-06T10:00:00Z",
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RegulatedPage />
    </QueryClientProvider>,
  );
}

function fillAndSubmit(isin: string, mic: string) {
  fireEvent.change(screen.getByLabelText("ISIN"), { target: { value: isin } });
  fireEvent.change(screen.getByRole("combobox", { name: "Exchange" }), { target: { value: mic } });
  const form = screen.getByRole("button", { name: "Check" }).closest("form") as HTMLFormElement;
  fireEvent.submit(form);
}

beforeEach(() => check.mockReset());
afterEach(cleanup);

describe("RegulatedPage", () => {
  it("has a heading and the ESMA intro", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Regulated?" })).toBeTruthy();
    expect(document.body.textContent).toContain("ESMA public registers");
  });

  it("uppercases the ISIN as typed and caps it at 12 characters", () => {
    renderPage();
    const field = screen.getByLabelText("ISIN") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "ie00" } });
    expect(field.value).toBe("IE00");
    expect(field.maxLength).toBe(12);
  });

  it("shows an accessible inline error for a bad ISIN and does not call the API", () => {
    renderPage();
    fillAndSubmit("IE00BMFKG445", "XETR");
    const field = screen.getByLabelText("ISIN");
    const error = screen.getByText(/valid 12-character ISIN/);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.getAttribute("role")).toBe("alert");
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects an exchange that is not in the list", () => {
    renderPage();
    fillAndSubmit(VALID_ISIN, "ZZZZ");
    expect(screen.getByText("Pick an exchange from the list.")).toBeTruthy();
    expect(check).not.toHaveBeenCalled();
  });

  it("shows a pending state while the check runs", async () => {
    check.mockReturnValue(new Promise(() => {}));
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    const button = (await screen.findByRole("button", { name: /Checking/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(check).toHaveBeenCalledWith(VALID_ISIN, "XETR");
  });

  it("regulated: green box with ISIN, MIC, segment and instrument", async () => {
    check.mockResolvedValue(base);
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    const box = await screen.findByRole("status");
    expect(box.getAttribute("data-tone")).toBe("green");
    expect(box.textContent).toContain(
      `${VALID_ISIN} is offered on a regulated market on XETR (XETA segment)`,
    );
    expect(box.textContent).toContain("iShares Core MSCI World");
  });

  it("not-offered: red box listing the checked segments", async () => {
    check.mockResolvedValue({
      ...base,
      verdict: "not-offered",
      matchedSegment: null,
      checkedSegments: ["XETA", "XETB"],
    });
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    const box = await screen.findByRole("status");
    expect(box.getAttribute("data-tone")).toBe("red");
    expect(box.textContent).toContain("Not offered on a regulated segment of XETR.");
    expect(box.textContent).toContain("XETA, XETB");
  });

  it("no-regulated-segment: red box naming the exchange", async () => {
    check.mockResolvedValue({ ...base, verdict: "no-regulated-segment", matchedSegment: null });
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    const box = await screen.findByRole("status");
    expect(box.getAttribute("data-tone")).toBe("red");
    expect(box.textContent).toContain(
      "Deutsche Börse Xetra (XETR) has no regulated-market segment in the ESMA register",
    );
  });

  it("not-in-esma: red box suggesting another exchange", async () => {
    check.mockResolvedValue({ ...base, verdict: "not-in-esma", matchedSegment: null });
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    const box = await screen.findByRole("status");
    expect(box.textContent).toContain("XETR is not in the ESMA register");
    expect(box.textContent).toContain("try another exchange");
  });

  it("esma-unavailable: explains the block and offers both manual links in new tabs", async () => {
    check.mockRejectedValue(
      new EsmaUnavailableError({
        venues: "https://esma.test/venues",
        instruments: "https://esma.test/firds",
      }),
    );
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    const box = await screen.findByRole("status");
    expect(box.textContent).toContain("temporarily blocking automated checks");
    for (const href of ["https://esma.test/venues", "https://esma.test/firds"]) {
      const link = box.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    }
  });

  it("a 401 asks the user to sign in again", async () => {
    check.mockRejectedValue(new ApiError("rls_denied", "unauthorized", 401));
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/sign in again/));
  });

  it("shows the slow-response line after 5s of waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      check.mockReturnValue(new Promise(() => {}));
      renderPage();
      fillAndSubmit(VALID_ISIN, "XETR");
      await screen.findByRole("button", { name: /Checking/ });
      expect(screen.queryByText(/still checking/)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(screen.getByText(/still checking/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("other failures show an alert", async () => {
    check.mockRejectedValue(new Error("boom"));
    renderPage();
    fillAndSubmit(VALID_ISIN, "XETR");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/went wrong/));
  });
});
