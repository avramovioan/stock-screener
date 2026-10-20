import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscount, makeScanStatus } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render-with-providers";

const api = vi.hoisted(() => ({ fetchTodaysDiscounts: vi.fn(), fetchScanStatus: vi.fn() }));
const quotes = vi.hoisted(() => ({ fetchQuotes: vi.fn() }));
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

import { TodaysDiscounts } from "./todays-discounts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  api.fetchTodaysDiscounts.mockReset();
  api.fetchScanStatus.mockResolvedValue(makeScanStatus());
  quotes.fetchQuotes.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const symbols = (testId: string) =>
  screen.queryAllByTestId(testId).map((el) => el.getAttribute("data-symbol"));

const card = async (symbol?: string) => {
  const all = await screen.findAllByTestId("discount-card");
  return (
    symbol ? all.find((c) => c.getAttribute("data-symbol") === symbol) : all[0]
  ) as HTMLElement;
};

const mount = (filter: "all" | "us" = "all") =>
  renderWithProviders(<TodaysDiscounts filter={filter} />);

const pending = (over = {}) =>
  makeDiscount({
    operational_category: "pending",
    category_reason: "not_requested",
    withheld: true,
    conclusion: null,
    summary: null,
    bankruptcy_risk: null,
    research_completed_at: null,
    ...over,
  });

describe("card states", () => {
  it("cleared: pill, summary, conclusion and risk, provenance, report link, trade control", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        rank: 62,
        yahoo_symbol: "MSFT",
        report_id: "rep-1",
        research_completed_at: "2026-10-15T08:00:00Z",
        conclusion: "Meets these two fundamental checks.",
      }),
    ]);
    mount();
    const q = within(await card());
    expect(q.getByRole("heading", { level: 2, name: "#62 MSFT" })).toBeTruthy();
    expect(q.getByTestId("card-state").textContent).toBe("Cleared");
    expect(q.getByText("Cloud and software company.")).toBeTruthy();
    expect(q.getByText("Conclusion").nextElementSibling?.textContent).toBe(
      "Meets these two fundamental checks.",
    );
    expect(q.getByText("Bankruptcy risk").nextElementSibling?.textContent).toBe("Low");
    expect(q.getByText(/Researched by Gemini 3.5 Flash,/).textContent).toContain("2 hours ago");
    expect(q.getByRole("link", { name: "Read the full report" }).getAttribute("href")).toBe(
      "/research/rep-1",
    );
    expect(q.getByTestId("trade-on-ibkr-button").textContent).toBe("Trade on IBKR");
    expect(q.getByRole("link", { name: "Show on graph" })).toBeTruthy();
  });

  it("caution: a reason sentence before the summary and the caution pill", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        operational_category: "amber",
        category_reason: "moderate_risk",
        bankruptcy_risk: "Moderate",
      }),
    ]);
    mount();
    const q = within(await card());
    expect(q.getByTestId("card-state").textContent).toBe("Cleared with caution");
    expect(q.getByText("Moderate bankruptcy risk. Cloud and software company.")).toBeTruthy();
    expect(q.getByText("Moderate")).toBeTruthy();
  });

  it("a deferred-quota row that is neither red nor grey is pending too", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ operational_category: "amber", category_reason: "research_quota_deferred" }),
    ]);
    mount();
    expect((await screen.findByTestId("discount-card")).getAttribute("data-state")).toBe("pending");
  });

  it("flagged: red joins the one grid, last, built like every other card, with the Avoid and Flagged tags", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        yahoo_symbol: "BAD",
        rank: 7,
        security_id: "sec-bad",
        operational_category: "red",
        category_reason: "bankruptcy_high",
        withheld: true,
        summary: "Going-concern doubt in the latest 10-K.",
        bankruptcy_risk: "High",
        is_top10: true,
        reached_line4: true,
        close: 242.5,
        line3_end: 266.14,
        line4_end: 247.3,
        since_date: "2026-10-14",
      }),
      makeDiscount({ yahoo_symbol: "G", rank: 1 }),
    ]);
    mount();
    await screen.findAllByTestId("discount-card");
    expect(screen.queryByRole("heading", { name: "Flagged" })).toBeNull();
    expect(screen.queryByText("High risk or inconclusive. Not discounts to act on.")).toBeNull();
    expect(symbols("discount-card")).toEqual(["G", "BAD"]);
    const el = await card("BAD");
    expect(el.className).not.toContain("bg-muted");
    const q = within(el);
    expect(q.getByRole("heading", { level: 2, name: /#7\s*BAD/ })).toBeTruthy();
    expect(q.getByTestId("verdict-tag").textContent).toBe("Avoid");
    expect(q.getByTestId("card-state").textContent).toBe("Flagged: High bankruptcy risk");
    const summary = q.getByText("Going-concern doubt in the latest 10-K.");
    expect(summary.className).not.toContain("text-tag-unavailable-fg");
    expect(q.queryByText(/Not a cleared discount/)).toBeNull();
    expect(q.getByRole("figure")).toBeTruthy();
    expect(q.queryByText(/^Closed 8\.9% below/)).toBeNull();
    expect(q.getByText("Conclusion")).toBeTruthy();
    expect(q.getByText("Bankruptcy risk")).toBeTruthy();
    expect(q.getByTestId("discount-tag").getAttribute("data-tag")).toBe("reached");
    expect(q.queryByText("Strong buy")).toBeNull();
    expect(q.getByTestId("trade-on-ibkr-button")).toBeTruthy();
    expect(q.getByRole("link", { name: "Show on graph" })).toBeTruthy();
    expect(
      q.getByRole("link", { name: "Show on graph" }).closest("footer")?.className,
    ).not.toContain("border-input");
  });

  it("a flagged card shows the verified EUR line like any other card", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        yahoo_symbol: "EURF",
        operational_category: "red",
        category_reason: "bankruptcy_high",
        withheld: true,
        eur_status: "verified",
        eur_symbol_yahoo: "EURF.DE",
      }),
    ]);
    mount();
    expect(await within(await card("EURF")).findByText(/^EURF\.DE, /)).toBeTruthy();
  });

  it("flagged labels: grey is Inconclusive, a withheld green row says Withheld", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        yahoo_symbol: "GR",
        rank: 1,
        operational_category: "grey",
        category_reason: "inconclusive",
        withheld: true,
      }),
      makeDiscount({
        yahoo_symbol: "GW",
        rank: 2,
        operational_category: "green",
        category_reason: "Publication held",
        withheld: true,
      }),
    ]);
    mount();
    const grey = within(await card("GR"));
    expect(grey.getByTestId("card-state").textContent).toBe("Flagged: Inconclusive");
    const withheld = within(await card("GW"));
    expect(withheld.getByTestId("card-state").textContent).toBe("Flagged: Withheld");
    expect(withheld.queryByText("Cleared")).toBeNull();
  });

  it("there is no Flagged group at all, and no <details> exists anywhere", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount()]);
    const { container } = mount();
    await card();
    expect(screen.queryByRole("heading", { name: "Flagged" })).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("provenance and the backup-model note", () => {
  const WHY = "Why the backup model was used";

  it("a backup-written report names the model, with an info button that opens why", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        research_model: "mistral-large-latest",
        research_provider: "mistral",
        fallback_reason: "primary_quota",
        research_completed_at: "2026-10-14T10:00:00Z",
      }),
    ]);
    mount();
    const q = within(await card());
    expect(q.getByText(/Researched by Mistral Large,/).textContent).toContain("1 day ago");
    expect(q.queryByRole("complementary")).toBeNull();
    expect(q.queryByRole("dialog")).toBeNull();
    fireEvent.click(q.getByRole("button", { name: WHY }));
    const box = await screen.findByRole("dialog", { name: WHY });
    expect(box.textContent).toBe(
      "Mistral Large, the backup model, wrote this report because Gemini's free daily quota was used up.",
    );
  });

  it("a Groq backup report with trimmed evidence says it was written from a shorter evidence set", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        research_model: "openai/gpt-oss-120b",
        research_provider: "groq",
        fallback_reason: "primary_unavailable",
        evidence_trimmed: true,
        research_completed_at: "2026-10-14T10:00:00Z",
      }),
    ]);
    mount();
    const q = within(await card());
    expect(q.getByText(/Researched by GPT-OSS 120B,/)).toBeTruthy();
    fireEvent.click(q.getByRole("button", { name: WHY }));
    expect((await screen.findByRole("dialog", { name: WHY })).textContent).toBe(
      "GPT-OSS 120B, the backup model, wrote this report from a shorter evidence set because Gemini was overloaded.",
    );
  });

  it("a backup report whose evidence was not trimmed keeps the original wording (false and null alike)", async () => {
    for (const trimmed of [false, null] as const) {
      api.fetchTodaysDiscounts.mockResolvedValue([
        makeDiscount({
          research_model: "openai/gpt-oss-120b",
          research_provider: "groq",
          fallback_reason: "primary_rate_limited",
          evidence_trimmed: trimmed,
          research_completed_at: "2026-10-14T10:00:00Z",
        }),
      ]);
      const { unmount } = mount();
      fireEvent.click(within(await card()).getByRole("button", { name: WHY }));
      expect((await screen.findByRole("dialog", { name: WHY })).textContent).toBe(
        "GPT-OSS 120B, the backup model, wrote this report because Gemini was rate limited.",
      );
      unmount();
    }
  });

  it("a flagged card shows the same info button for a backup report", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        operational_category: "red",
        category_reason: "bankruptcy_high",
        withheld: true,
        research_model: "openai/gpt-oss-120b",
        fallback_reason: "primary_unavailable",
        research_completed_at: "2026-10-14T10:00:00Z",
      }),
    ]);
    mount();
    expect(within(await card()).getByRole("button", { name: WHY })).toBeTruthy();
  });

  it("a Gemini report shows no info button and no note", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount()]);
    mount();
    const q = within(await card());
    expect(q.getByText(/Researched by Gemini/)).toBeTruthy();
    expect(q.queryByRole("button", { name: WHY })).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("order and country filter", () => {
  it("orders cleared, then caution, then pending, each by rank; flagged last in its own group", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      pending({ yahoo_symbol: "PEN1", rank: 1 }),
      makeDiscount({
        yahoo_symbol: "AMB",
        rank: 2,
        operational_category: "amber",
        category_reason: "moderate_risk",
      }),
      makeDiscount({ yahoo_symbol: "G5", rank: 5 }),
      makeDiscount({
        yahoo_symbol: "RED",
        rank: 3,
        operational_category: "red",
        withheld: true,
        category_reason: "bankruptcy_high",
      }),
      makeDiscount({ yahoo_symbol: "G2", rank: 2, security_id: "s-g2" }),
      pending({ yahoo_symbol: "PEN0", rank: 0 }),
    ]);
    mount();
    await screen.findAllByTestId("discount-card");
    expect(symbols("discount-card")).toEqual(["G2", "G5", "AMB", "PEN0", "PEN1", "RED"]);
  });

  it("the US filter keeps United States rows only (cards and flagged)", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "US1", rank: 1 }),
      makeDiscount({ yahoo_symbol: "JP1", rank: 2, country: "Japan", listing_country: "Japan" }),
      makeDiscount({ yahoo_symbol: "NUL", rank: 3, country: null, listing_country: null }),
      makeDiscount({ yahoo_symbol: "AON", rank: 5, country: "United Kingdom" }),
      makeDiscount({
        yahoo_symbol: "JPR",
        rank: 4,
        country: "Japan",
        listing_country: "Japan",
        operational_category: "red",
        withheld: true,
      }),
    ]);
    mount("us");
    await screen.findAllByTestId("discount-card");
    expect(symbols("discount-card")).toEqual(["US1", "AON"]);
  });

  it("shows the flag and the country in the identity line, a neutral flag for an unknown country", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "A", rank: 1, country: "Japan", exchange_name: "Tokyo" }),
      makeDiscount({ yahoo_symbol: "B", rank: 2, country: null, exchange_name: "XYZ" }),
    ]);
    mount();
    const a = within(await card("A"));
    expect(a.getByText("Japan · Tokyo · Yahoo A")).toBeTruthy();
    expect((await card("A")).querySelector("[data-flag='JP']")).toBeTruthy();
    const b = within(await card("B"));
    expect(b.getByText("XYZ · Yahoo B")).toBeTruthy();
    expect((await card("B")).querySelector("[data-flag='unknown']")).toBeTruthy();
  });
});

const MCD = {
  yahoo_symbol: "MCD",
  rank: 101,
  is_top10: false,
  reached_line4: true,
  close: 242.5,
  line3_end: 266.14,
  line4_end: 247.3,
  since_date: "2026-10-15",
  session_date: "2026-10-15",
};
const AON = {
  yahoo_symbol: "AON",
  rank: 333,
  is_top10: false,
  reached_line4: false,
  close: 286.8,
  line3_end: 307.55,
  line4_end: 280.99,
  since_date: "2026-10-15",
  session_date: "2026-10-15",
};

describe("gauge", () => {
  it("at the −4 line: both percentages, since date, both markers labelled, aria-label with both distances", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount(MCD)]);
    mount();
    const q = within(await card());
    expect(q.getByText("8.9% below its −3 line")).toBeTruthy();
    expect(q.getByText(/^and 1.9% below its −4 line, since Oct 15.$/)).toBeTruthy();
    expect(q.getByRole("figure").getAttribute("aria-label")).toBe(
      "Close is 8.9% below its −3 line of $266.14 and 1.9% below its −4 line of $247.30",
    );
    expect(q.getByText("Close, Oct 15")).toBeTruthy();
    expect(q.getByText("−4 $247.30")).toBeTruthy();
    expect(q.getByText("−3 $266.14")).toBeTruthy();
    expect(q.getAllByText("$242.50").length).toBeGreaterThanOrEqual(2);
    expect(q.queryByTestId("gauge-labels-merged")).toBeNull();
  });

  it("reads −3 on the left and −4 on the right, the close in between or beyond", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount(MCD)]);
    mount();
    const q = within(await card());
    const left = (el: HTMLElement) => Number.parseFloat(el.style.left);
    expect(left(q.getByText("−3 $266.14"))).toBeLessThan(left(q.getByText("−4 $247.30")));
  });

  it("between the lines: one clause, and the −4 line is N% lower", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount(AON)]);
    mount();
    const q = within(await card());
    expect(q.getByText("6.7% below its −3 line")).toBeTruthy();
    expect(q.getByText(", since Oct 15.")).toBeTruthy();
    expect(q.getByRole("figure").getAttribute("aria-label")).toBe(
      "Close is 6.7% below its −3 line of $307.55. The −4 line, $280.99, is 2.0% lower",
    );
  });

  it("very close lines share one left-aligned label group, −3 before −4", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        close: 60,
        line3_end: 110,
        line4_end: 105,
        reached_line4: true,
        since_date: "2026-10-15",
      }),
    ]);
    mount();
    const group = within(await card()).getByTestId("gauge-labels-merged");
    expect(group.textContent).toBe("−3 $110.00−4 $105.00");
  });
});

describe("tag", () => {
  it("top 10 at the −4 line reads Reached −4 under the gauge, and Strong buy only in the header", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount({ ...MCD, rank: 6, is_top10: true })]);
    mount();
    const q = within(await card());
    expect(q.getByTestId("discount-tag").getAttribute("data-tag")).toBe("reached");
    expect(q.getByText("Reached −4")).toBeTruthy();
    expect(q.queryByText("A top 10 company at or below its −3 line.")).toBeNull();
    expect(q.getByTestId("verdict-tag").textContent).toBe("Strong buy");
    expect(within(q.getByTestId("discount-tag")).queryByText("Strong buy")).toBeNull();
  });

  it("rank 11+ at the −4 line: Reached −4", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount(MCD)]);
    mount();
    const q = within(await card());
    expect(q.getByText("Reached −4")).toBeTruthy();
    expect(q.queryByText(/is .*% lower./)).toBeNull();
  });

  it("rank 11+ between the lines: Wait for −4, the gap to it, and Consider in the header", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount(AON)]);
    mount();
    const q = within(await card());
    expect(q.getByText("Wait for −4")).toBeTruthy();
    expect(q.getByText("The −4 line, $280.99, is 2.0% lower.")).toBeTruthy();
    expect(q.getByTestId("verdict-tag").textContent).toBe("Consider");
  });

  it("pending cards are tagged too", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([pending(AON)]);
    mount();
    expect(within(await card()).getByText("Wait for −4")).toBeTruthy();
  });

  it("verdict tags use the shared status-tag class with a bordered tone for each of the four verdicts", async () => {
    const cases: Array<[string, string, string, () => unknown]> = [
      ["strong", "Strong buy", "green", () => makeDiscount({ ...MCD, rank: 6, is_top10: true })],
      ["consider", "Consider", "consider", () => makeDiscount(AON)],
      ["unchecked", "Unchecked", "grey", () => pending(AON)],
      [
        "avoid",
        "Avoid",
        "red",
        () =>
          makeDiscount({
            yahoo_symbol: "BAD",
            rank: 7,
            security_id: "sec-bad",
            operational_category: "red",
            category_reason: "bankruptcy_high",
            withheld: true,
            summary: "Going-concern doubt in the latest 10-K.",
            bankruptcy_risk: "High",
            is_top10: true,
            reached_line4: true,
            close: 242.5,
            line3_end: 266.14,
          }),
      ],
    ];
    for (const [tag, label, tone, row] of cases) {
      api.fetchTodaysDiscounts.mockResolvedValue([row()]);
      cleanup();
      mount();
      const pill = within(await card()).getByTestId("verdict-tag");
      expect(pill.getAttribute("data-tag"), tag).toBe(tag);
      expect(pill.className, tag).toContain("status-tag");
      expect(pill.getAttribute("data-tone"), tag).toBe(tone);
      expect(pill.textContent, tag).toBe(label);
    }
  });
});

describe("gauge misc", () => {
  it("a stale close shows the stale tag instead of the plain close date", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ data_freshness: "stale", session_date: "2026-10-09" }),
    ]);
    mount();
    const q = within(await card());
    expect(q.getByTestId("freshness-stale")).toBeTruthy();
    expect(q.queryByText(/^Close, /)).toBeNull();
  });
});

describe("home tickers", () => {
  it("shows the exchange-local ticker large and the Yahoo symbol in the identity line", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({
        rank: 114,
        yahoo_symbol: "RMS.PA",
        exchange_code: "PAR",
        exchange_name: "Euronext Paris",
        country: "France",
        listing_country: "France",
        currency: "EUR",
      }),
    ]);
    mount();
    const el = await card("RMS.PA");
    const q = within(el);
    expect(q.getByRole("heading", { level: 2, name: "#114 RMS" })).toBeTruthy();
    expect(q.getByText("France · Euronext Paris · Yahoo RMS.PA")).toBeTruthy();
  });

  it("keeps a US symbol with a dot as it is", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ rank: 7, yahoo_symbol: "BRK.B", exchange_code: "NYQ" }),
    ]);
    mount();
    expect(within(await card()).getByRole("heading", { name: "#7 BRK.B" })).toBeTruthy();
  });
});

describe("EUR line and actions", () => {
  it("verified EUR listing shows ticker, delayed EUR price and time", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "MSFT", eur_status: "verified", eur_symbol_yahoo: "MSF.DE" }),
    ]);
    quotes.fetchQuotes.mockResolvedValue([
      {
        symbol: "MSF.DE",
        currency: "EUR",
        exchange: "GER",
        fullExchangeName: "XETRA",
        longName: null,
        regularMarketPrice: 380.25,
        regularMarketTime: Date.parse("2026-10-15T07:41:00Z"),
        regularMarketChangePercent: 0.1,
        marketState: "REGULAR",
        fetchedAt: "2026-10-15T07:45:00Z",
        stale: false,
      },
    ]);
    mount();
    expect(await screen.findByText(/MSF\.DE, €380.25, delayed Oct 15, 10:41/)).toBeTruthy();
    expect(quotes.fetchQuotes).toHaveBeenCalledWith(["MSF.DE"]);
  });

  it("verified listing without a quote says the EUR price is unavailable", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ eur_status: "verified", eur_symbol_yahoo: "MSF.DE" }),
    ]);
    mount();
    expect(await screen.findByText(/MSF\.DE, EUR price unavailable/)).toBeTruthy();
  });

  it("an unverified or missing listing requests no EUR quote", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "A", eur_status: "unverified", eur_symbol_yahoo: "MSF.DE" }),
      makeDiscount({ yahoo_symbol: "B", rank: 2, eur_status: "none", eur_symbol_yahoo: null }),
    ]);
    mount();
    await screen.findAllByTestId("discount-card");
    expect(screen.queryByText(/No verified EUR listing yet\./)).toBeNull();
    expect(quotes.fetchQuotes).not.toHaveBeenCalledWith(["MSF.DE"]);
  });

  it("Show on graph links to /quotes with the symbol and the security, without a mode", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "MSFT", security_id: "sec-9" }),
    ]);
    mount();
    const link = (await screen.findByRole("link", { name: "Show on graph" })) as HTMLAnchorElement;
    const href = link.getAttribute("href") ?? "";
    expect(href).toMatch(/^\/quotes\?/);
    expect(href).toContain("symbol=MSFT");
    expect(href).toContain("sid=sec-9");
    expect(href).not.toContain("mode=");
    expect(link.className).toContain("underline");
  });

  it("every viewer gets Trade on IBKR; no sign-in or Profile link replaces it", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount()]);
    mount();
    expect(await screen.findByTestId("trade-on-ibkr-button")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in to trade" })).toBeNull();
    expect(screen.queryByText("Link IBKR in Profile → Broker")).toBeNull();
  });

  it("an enabled Trade on IBKR button, never labelled Submit Order", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount()]);
    mount();
    const btn = (await screen.findByTestId("trade-on-ibkr-button")) as HTMLButtonElement;
    expect(btn.textContent).toBe("Trade on IBKR");
    expect(btn.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /submit order/i })).toBeNull();
  });
});

describe("states of the list", () => {
  it("empty: No discounts today", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No discounts today")).toBeTruthy();
  });

  it("error state offers Retry", async () => {
    api.fetchTodaysDiscounts.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
