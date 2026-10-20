import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSofiaShort } from "@/lib/format";
import { makeDiscount, makeScanStatus } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const api = vi.hoisted(() => ({
  fetchTodaysDiscounts: vi.fn(),
  fetchScanStatus: vi.fn(),
  fetchResearchQuota: vi.fn(),
}));
const quotes = vi.hoisted(() => ({ fetchQuotes: vi.fn() }));
const request = vi.hoisted(() => ({ requestResearch: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/features/screening/api", () => ({
  ...api,
  fetchCompanyList: vi.fn(),
  fetchShortSummary: vi.fn(),
  fetchPriceSeries: vi.fn(),
}));
vi.mock("@/features/screening/quotes-api", () => ({
  ...quotes,
  searchSymbols: vi.fn(),
  fetchChartBySymbol: vi.fn(),
}));
vi.mock("@/features/screening/research-request-api", () => request);

import { clearBridgedScans } from "./research-panel";
import { buildResearchPrompt } from "./research-prompt";
import { TodaysDiscounts } from "./todays-discounts";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const writeText = vi.fn();

beforeEach(() => {
  clearBridgedScans();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  api.fetchTodaysDiscounts.mockReset();
  api.fetchScanStatus.mockResolvedValue(makeScanStatus());
  api.fetchResearchQuota.mockReset().mockResolvedValue({ available: true, next_reset_at: null });
  quotes.fetchQuotes.mockReset().mockResolvedValue([]);
  request.requestResearch.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const unscanned = (over = {}) =>
  makeDiscount({
    operational_category: "pending",
    category_reason: "not_requested",
    withheld: true,
    conclusion: null,
    summary: null,
    bankruptcy_risk: null,
    research_completed_at: null,
    report_id: null,
    ...over,
  });

const panel = async () => within(await screen.findByTestId("research-panel"));
const mount = () => renderWithProviders(<TodaysDiscounts filter="all" />);

describe("not scanned", () => {
  it("shows the invitation, an enabled Scan with AI and the run-it-yourself buttons", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    mount();
    const p = await panel();
    expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("not_scanned");
    expect(p.getByText("No AI research yet")).toBeTruthy();
    expect(
      p.getByText(
        "Anyone can start one. Free, usually a few minutes. One scan per company every 72 hours.",
      ),
    ).toBeTruthy();
    expect((p.getByRole("button", { name: "Scan with AI" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
  });

  it("an expired report (older than 30 days) is not scanned again", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ research_completed_at: ago(31 * 24 * 60) }),
    ]);
    mount();
    expect((await panel()).getByText("No AI research yet")).toBeTruthy();
  });

  it("the trade control shows for every viewer, with no research gating", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    mount();
    const card = within(await screen.findByTestId("discount-card"));
    expect(card.getByTestId("trade-on-ibkr-button")).toBeTruthy();
    expect(card.queryByText("Trading opens after research clears")).toBeNull();
  });
});

describe("Scan with AI", () => {
  it("asks the server for this security, then refetches the feed and shows the running state", async () => {
    api.fetchTodaysDiscounts.mockResolvedValueOnce([unscanned({ security_id: "sec-7" })]);
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({
        security_id: "sec-7",
        category_reason: "research_pending",
        research_started_at: ago(0),
        research_requested_by: "visitor",
      }),
    ]);
    request.requestResearch.mockResolvedValue({
      ok: true,
      reportId: "r1",
      startedAt: ago(0),
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    await waitFor(() => expect(request.requestResearch).toHaveBeenCalledWith("sec-7"));
    await waitFor(() =>
      expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("running"),
    );
    await waitFor(() => expect(api.fetchTodaysDiscounts).toHaveBeenCalledTimes(2));
  });

  it.each([["network_limit"]] as const)(
    "a %s refusal shows the limits state without a toast",
    async (reason) => {
      api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
      request.requestResearch.mockResolvedValue({ ok: false, reason, nextAllowedAt: null });
      mount();
      fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
      await waitFor(() =>
        expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("limits"),
      );
      const p = within(screen.getByTestId("research-panel"));
      expect(p.getByText("Scans are paused for now")).toBeTruthy();
      expect(
        p.getByText(
          "Either your network started several scans in the last hour, or today's free AI budget is used up. Try again later, or run the evaluation yourself with the prompt.",
        ),
      ).toBeTruthy();
      expect((p.getByRole("button", { name: "Scan with AI" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("a try_later refusal says it could not start, with an enabled Try again that asks again", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    request.requestResearch.mockResolvedValue({
      ok: false,
      reason: "try_later",
      nextAllowedAt: null,
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    expect(await screen.findByText("Couldn't start the scan right now")).toBeTruthy();
    const p = within(screen.getByTestId("research-panel"));
    expect(
      p.getByText("Something went wrong on our side. Please try again in a few minutes."),
    ).toBeTruthy();
    expect(p.queryByRole("button", { name: "Scan with AI" })).toBeNull();
    const again = p.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
    expect(p.queryByText("Scans are paused for now")).toBeNull();
    fireEvent.click(again);
    await waitFor(() => expect(request.requestResearch).toHaveBeenCalledTimes(2));
  });

  it("a retry_later refusal shows the failed state with the minutes left", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    request.requestResearch.mockResolvedValue({
      ok: false,
      reason: "retry_later",
      nextAllowedAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(),
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    await waitFor(() =>
      expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("failed"),
    );
    expect(
      within(screen.getByTestId("research-panel")).getByRole("button", {
        name: "Try again in 25 min",
      }),
    ).toBeTruthy();
  });

  it("a cooldown refusal says when the next scan is possible", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    request.requestResearch.mockResolvedValue({
      ok: false,
      reason: "cooldown",
      nextAllowedAt: new Date(NOW.getTime() + 70 * 3_600_000).toISOString(),
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    expect(
      await within(screen.getByTestId("research-panel")).findByText(
        /^A new scan can be requested from /,
      ),
    ).toBeTruthy();
  });

  it("an in_flight answer shows Scanning at once with the start and the requester it gave, and refetches the feed", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    request.requestResearch.mockResolvedValue({
      ok: false,
      reason: "in_flight",
      nextAllowedAt: null,
      startedAt: ago(1),
      requestedBy: "visitor",
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    await waitFor(() =>
      expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("running"),
    );
    const p = within(screen.getByTestId("research-panel"));
    expect(
      p.getByText(
        "Started 1 minute ago by a visitor. Usually a few minutes. This card updates by itself when it is done.",
      ),
    ).toBeTruthy();
    expect(p.queryByRole("button", { name: /Scan|Starting/ })).toBeNull();
    await waitFor(() => expect(api.fetchTodaysDiscounts).toHaveBeenCalledTimes(2));
  });

  it("an in_flight answer without a start says Waiting to start.", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    request.requestResearch.mockResolvedValue({
      ok: false,
      reason: "in_flight",
      nextAllowedAt: null,
      startedAt: null,
      requestedBy: null,
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    expect(await screen.findByText(/^Waiting to start\./)).toBeTruthy();
  });

  it("a cooldown answer refetches the feed and shows the finished card in place, no error", async () => {
    api.fetchTodaysDiscounts.mockResolvedValueOnce([unscanned()]);
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        research_completed_at: ago(0),
        summary: "Fresh summary from the other scan.",
      }),
    ]);
    request.requestResearch.mockResolvedValue({
      ok: false,
      reason: "cooldown",
      nextAllowedAt: new Date(NOW.getTime() + 72 * 3_600_000).toISOString(),
    });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    expect(await screen.findByText("Fresh summary from the other scan.")).toBeTruthy();
    expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("done");
    expect(screen.queryByText("Couldn't start the scan right now")).toBeNull();
    expect(screen.queryByText("Scans are paused for now")).toBeNull();
  });
});

describe("starting", () => {
  it("shows a spinning, disabled Starting button only while the request is on its way", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    let answer: (v: unknown) => void = () => undefined;
    request.requestResearch.mockReturnValue(new Promise((r) => (answer = r)));
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    const p = await panel();
    const starting = (await p.findByRole("button", { name: "Starting…" })) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    expect(starting.getAttribute("aria-busy")).toBe("true");
    expect(starting.querySelector("[data-spinner]")).toBeTruthy();
    expect(p.getByText("No AI research yet")).toBeTruthy();
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
    await act(async () => {
      answer({ ok: false, reason: "try_later", nextAllowedAt: null });
    });
    await waitFor(() => expect(p.queryByRole("button", { name: "Starting…" })).toBeNull());
    expect((p.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("running", () => {
  it("shows a pulsing dot, a moving bar, who started it and Copy the prompt, and no Scan button", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({
        category_reason: "research_pending",
        research_started_at: ago(12),
        research_requested_by: "visitor",
      }),
    ]);
    mount();
    const p = await panel();
    expect(p.getByText("AI research running")).toBeTruthy();
    expect(
      p.getByText(
        "Started 12 minutes ago by a visitor. Usually a few minutes. This card updates by itself when it is done.",
      ),
    ).toBeTruthy();
    const bar = p.getByRole("progressbar", { name: "AI research in progress" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("aria-valuemax")).toBe(false);
    expect(p.getByText("AI research running").querySelector("[data-pulse]")).toBeTruthy();
    expect(p.queryByRole("button", { name: /Scan/ })).toBeNull();
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
  });

  it("names a busy provider or a spent quota on a second line", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({
        research_started_at: ago(30),
        research_requested_by: "visitor",
        research_wait_reason: "rate_limited",
      }),
    ]);
    mount();
    expect((await panel()).getByText("Provider busy, retrying")).toBeTruthy();
  });

  it("a run older than 90 minutes says it is taking longer", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_started_at: ago(120), research_requested_by: "owner" }),
    ]);
    mount();
    const p = await panel();
    expect(
      p.getByText(
        /Taking longer than usual\. An unfinished scan is retried after the daily reset\.$/,
      ),
    ).toBeTruthy();
    expect(p.queryByText(/Usually a few minutes/)).toBeNull();
    expect(p.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });

  it("says who asked: the owner, the daily scan, or nobody named", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_started_at: ago(5), research_requested_by: "owner" }),
    ]);
    const { unmount } = mount();
    expect((await panel()).getByText(/^Started 5 minutes ago by the owner\./)).toBeTruthy();
    unmount();
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_started_at: ago(5), research_requested_by: null }),
    ]);
    mount();
    expect((await panel()).getByText(/^Started 5 minutes ago\. Usually/)).toBeTruthy();
  });
});

describe("paused", () => {
  it("shows the reason and the resume time, no bar, no usual-time sentence", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({
        research_started_at: ago(360),
        research_requested_by: "owner",
        research_wait_reason: "llm_quota",
        next_attempt_at: "2026-10-20T06:00:00Z",
      }),
    ]);
    mount();
    const root = await screen.findByTestId("research-panel");
    expect(root.getAttribute("data-research")).toBe("paused");
    const p = within(root);
    expect(p.getByText("Research paused")).toBeTruthy();
    expect(p.getByText("Today's free AI budget is used up.")).toBeTruthy();
    expect(p.getByText(/^Resumes .+\.$/)).toBeTruthy();
    expect(p.queryByRole("progressbar")).toBeNull();
    expect(p.queryByText(/Started|Usually 15/)).toBeNull();
    expect(p.queryByRole("button", { name: /Scan/ })).toBeNull();
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
  });

  it("without next_attempt_at it resumes at the next scan", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_wait_reason: "weekend", next_attempt_at: null }),
    ]);
    mount();
    expect((await panel()).getByText("Resumes at the next scan.")).toBeTruthy();
  });
});

describe("done", () => {
  it("keeps the verdict, adds Next AI scan in N h and Copy the prompt, and no Scan button", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ research_completed_at: ago(2 * 60) }),
    ]);
    mount();
    const card = within(await screen.findByTestId("discount-card"));
    expect(card.getByText(/Researched by Gemini 3.5 Flash,/).textContent).toContain("2 hours ago");
    const p = await panel();
    expect(
      p.getByText(`A new scan can be requested from ${formatSofiaShort("2026-10-22T10:00:00Z")}`),
    ).toBeTruthy();
    expect(p.queryByText(/Next AI scan in/)).toBeNull();
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
    expect(p.queryByRole("button", { name: /Scan/ })).toBeNull();
  });

  it("after 72 hours the card offers Scan with AI again", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ research_completed_at: ago(80 * 60) }),
    ]);
    mount();
    const p = await panel();
    expect(p.queryByText(/A new scan can be requested/)).toBeNull();
    expect(
      (p.getByRole("button", { name: "Scan again with AI" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("a flagged card carries the research controls too", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        operational_category: "red",
        category_reason: "bankruptcy_high",
        withheld: true,
        research_completed_at: ago(60),
      }),
    ]);
    mount();
    expect((await panel()).getByText(/^A new scan can be requested from /)).toBeTruthy();
  });
});

describe("failed", () => {
  it("says the last scan failed and enables Scan with AI once the retry wait has passed", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned({ research_failed_at: ago(90) })]);
    mount();
    const p = await panel();
    expect(p.getByText("The last scan failed")).toBeTruthy();
    expect((p.getByRole("button", { name: "Scan with AI" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("counts down to the retry", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned({ research_failed_at: ago(20) })]);
    mount();
    const p = await panel();
    expect(
      (p.getByRole("button", { name: "Try again in 40 min" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("newest result wins", () => {
  it("a finished card with an older parked report shows done, never paused", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        research_completed_at: ago(60),
        research_started_at: ago(600),
        research_wait_reason: "llm_quota",
        research_requested_by: "visitor",
      }),
    ]);
    mount();
    const p = await panel();
    expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe("done");
    expect(p.queryByText("Research paused")).toBeNull();
    expect(p.queryByRole("button", { name: "Scanning…" })).toBeNull();
  });
});

describe("providers busy", () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  };

  it("explains the overload, keeps the button off until 15 minutes after the failure, then enables it", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(NOW);
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_failed_at: ago(10), research_failed_reason: "providers_busy" }),
    ]);
    mount();
    await flush();
    const root = screen.getByTestId("research-panel");
    const p = within(root);
    expect(p.getByText("AI providers are busy")).toBeTruthy();
    expect(
      p.getByText(
        `Gemini was overloaded and the backups were at their limit. Try again after ${formatSofiaShort(new Date(NOW.getTime() + 5 * 60_000))}.`,
      ),
    ).toBeTruthy();
    const btn = p.getByRole("button", { name: "Try again with AI" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    });
    const after = within(screen.getByTestId("research-panel"));
    expect(
      (after.getByRole("button", { name: "Try again with AI" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      after.getByText(
        "Gemini was overloaded and the backups were at their limit. You can try again now.",
      ),
    ).toBeTruthy();
    expect(after.queryByText(/Try again after/)).toBeNull();
  });
});

describe("no free quota", () => {
  it("a no_quota failure shows the block with the reset time from the quota status and no Scan button", async () => {
    api.fetchResearchQuota.mockResolvedValue({
      available: false,
      next_reset_at: "2026-10-20T07:00:00Z",
    });
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_failed_at: ago(10), research_failed_reason: "no_quota" }),
    ]);
    mount();
    const p = await panel();
    expect(await p.findByText("No free AI quota left today")).toBeTruthy();
    expect(
      await p.findByText(
        `Run the evaluation in your own AI. Free quota returns ${formatSofiaShort("2026-10-20T07:00:00Z")}.`,
      ),
    ).toBeTruthy();
    expect(p.queryByRole("button", { name: /Scan|Try again/ })).toBeNull();
    expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
  });

  it("a no_quota failure becomes a normal not scanned card with the Scan button once the quota is available again", async () => {
    api.fetchResearchQuota.mockResolvedValue({ available: true, next_reset_at: null });
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ research_failed_at: ago(10), research_failed_reason: "no_quota" }),
    ]);
    mount();
    const p = await panel();
    await waitFor(() =>
      expect(screen.getByTestId("research-panel").getAttribute("data-research")).toBe(
        "not_scanned",
      ),
    );
    expect(p.getByText("No AI research yet")).toBeTruthy();
    expect((p.getByRole("button", { name: "Scan with AI" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(p.queryByText("No free AI quota left today")).toBeNull();
  });

  it("when the quota status says unavailable, every card that would offer a scan shows the block", async () => {
    api.fetchResearchQuota.mockResolvedValue({
      available: false,
      next_reset_at: "2026-10-20T07:00:00Z",
    });
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ yahoo_symbol: "A", rank: 1 }),
      makeDiscount({ yahoo_symbol: "B", rank: 2, research_completed_at: ago(80 * 60) }),
      unscanned({ yahoo_symbol: "C", rank: 3, research_failed_at: ago(90) }),
      unscanned({ yahoo_symbol: "D", rank: 4, research_started_at: ago(5) }),
    ]);
    mount();
    await waitFor(() => expect(screen.getAllByText("No free AI quota left today")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: /Scan|Try again/ })).toBeNull();
    expect(screen.getAllByText("AI research running")).toHaveLength(1);
  });

  it("a quota status that cannot be read does not block scans", async () => {
    api.fetchResearchQuota.mockRejectedValue(new Error("down"));
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    mount();
    expect(
      ((await panel()).getByRole("button", { name: "Scan with AI" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it.each([["no_quota"], ["budget_paused"]] as const)(
    "a %s answer from the endpoint shows the block",
    async (reason) => {
      api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
      request.requestResearch.mockResolvedValue({
        ok: false,
        reason,
        nextAllowedAt: "2026-10-20T07:00:00Z",
      });
      mount();
      fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
      expect(await screen.findByText("No free AI quota left today")).toBeTruthy();
      const p = within(screen.getByTestId("research-panel"));
      expect(p.queryByRole("button", { name: /Scan/ })).toBeNull();
      expect(p.getByRole("button", { name: "Copy the prompt" })).toBeTruthy();
    },
  );
});

describe("run it in your own AI", () => {
  it("the Copy button copies the prompt of the card and toasts", async () => {
    const row = unscanned({ name: "McDonald's Corporation", yahoo_symbol: "MCD" });
    api.fetchTodaysDiscounts.mockResolvedValue([row]);
    mount();
    const p = await panel();
    await act(async () => {
      fireEvent.click(p.getByRole("button", { name: "Copy the prompt" }));
    });
    expect(writeText).toHaveBeenCalledWith(buildResearchPrompt(row));
    expect(toasts.success).toHaveBeenCalledWith("Prompt copied.");
  });

  it("is on every state, as the label and the four AI buttons plus Copy", async () => {
    api.fetchResearchQuota.mockResolvedValue({ available: true, next_reset_at: null });
    api.fetchTodaysDiscounts.mockResolvedValue([
      unscanned({ yahoo_symbol: "A", rank: 1 }),
      unscanned({ yahoo_symbol: "B", rank: 2, research_started_at: ago(3) }),
      makeDiscount({ yahoo_symbol: "C", rank: 3, research_completed_at: ago(60) }),
      unscanned({ yahoo_symbol: "D", rank: 4, research_failed_at: ago(5) }),
      unscanned({
        yahoo_symbol: "E",
        rank: 5,
        research_failed_at: ago(5),
        research_failed_reason: "providers_busy",
      }),
      unscanned({
        yahoo_symbol: "F",
        rank: 6,
        research_started_at: ago(300),
        research_wait_reason: "llm_quota",
      }),
    ]);
    mount();
    await screen.findAllByTestId("research-panel");
    for (const name of [
      "Copy the prompt",
      "Open the prompt in ChatGPT",
      "Open the prompt in Claude",
      "Open the prompt in Grok",
      "Copy the prompt for Gemini",
    ]) {
      expect(screen.getAllByRole("button", { name })).toHaveLength(6);
    }
    expect(screen.getAllByText("Or run the evaluation in your own AI")).toHaveLength(6);
  });

  it("is on the no-quota block too", async () => {
    api.fetchResearchQuota.mockResolvedValue({ available: false, next_reset_at: null });
    api.fetchTodaysDiscounts.mockResolvedValue([unscanned()]);
    mount();
    const p = await panel();
    expect(await p.findByText("No free AI quota left today")).toBeTruthy();
    expect(p.getByRole("button", { name: "Open the prompt in ChatGPT" })).toBeTruthy();
  });
});

describe("finished in place", () => {
  const running = () =>
    unscanned({
      research_started_at: ago(1),
      research_requested_by: "visitor",
      report_id: "rep-9",
      security_id: "sec-9",
    });
  const finished = () =>
    makeDiscount({
      security_id: "sec-9",
      report_id: "rep-9",
      research_completed_at: ago(0),
      research_started_at: ago(1),
      research_requested_by: null,
    });

  it("a scan seen running that completes gets one toast with Open report and a 2 s outline", async () => {
    api.fetchTodaysDiscounts.mockResolvedValueOnce([running()]);
    api.fetchTodaysDiscounts.mockResolvedValue([finished()]);
    const { queryClient } = mount();
    const card = await screen.findByTestId("discount-card");
    expect(toasts.success).not.toHaveBeenCalled();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["discounts"] });
    });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    const [text, options] = toasts.success.mock.calls[0] as [string, { action: { label: string } }];
    expect(text).toBe("AI research for MSFT is ready.");
    expect(options.action.label).toBe("Open report");
    expect(card.getAttribute("data-just-finished")).toBe("true");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["discounts"] });
    });
    expect(toasts.success).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(card.getAttribute("data-just-finished")).toBe("false"), {
      timeout: 3000,
    });
  });

  it("this page's own click that is bridged still gets the notice when the feed jumps straight to a complete report", async () => {
    api.fetchTodaysDiscounts.mockResolvedValueOnce([
      unscanned({ security_id: "sec-9", report_id: "rep-9" }),
    ]);
    api.fetchTodaysDiscounts.mockResolvedValue([finished()]);
    request.requestResearch.mockResolvedValue({ ok: true, reportId: "rep-9", startedAt: ago(0) });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan with AI" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(toasts.success.mock.calls[0]?.[0]).toBe("AI research for MSFT is ready.");
    expect(screen.getByTestId("discount-card").getAttribute("data-just-finished")).toBe("true");
  });

  it("an older report on a card that is rescanned does not count as the new result", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ security_id: "sec-9", research_completed_at: ago(80 * 60) }),
    ]);
    request.requestResearch.mockResolvedValue({ ok: true, reportId: "r", startedAt: ago(0) });
    mount();
    fireEvent.click((await panel()).getByRole("button", { name: "Scan again with AI" }));
    await waitFor(() => expect(request.requestResearch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("a card first seen finished never toasts", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([finished()]);
    mount();
    await screen.findByTestId("discount-card");
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByTestId("discount-card").getAttribute("data-just-finished")).toBe("false");
  });
});
