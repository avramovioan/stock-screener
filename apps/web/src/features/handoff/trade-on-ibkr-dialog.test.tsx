import { NO_ORDER_NOTICE } from "@core/handoff.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradeOnIbkrDialog } from "./trade-on-ibkr-dialog";
import type { HeldTarget, TradeTarget } from "./types";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getCatalogueListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
  quotes: { useQuotes: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);
vi.mock("@/features/screening/quotes-hooks", () => mocks.quotes);

const TARGET: TradeTarget = {
  securityId: "sec-msft",
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  rank: 53,
  exchangeName: "NasdaqGS",
  currency: "USD",
  exchangeCode: "NMS",
};

const row = (over: Record<string, unknown> = {}) => ({
  exchange: "IBIS" as const,
  status: "verified" as const,
  conid: 12178239,
  localSymbol: "MSF",
  isin: "US5949181045",
  eurSymbolYahoo: "MSF.DE",
  verifiedAt: "2026-10-15T07:30:00Z",
  verification: {
    method: "automatic",
    failed: [],
    checks: { isin_confirmed: "pass", price_within_tolerance: "pass" },
  },
  ...over,
});
const eurQuote = (over: Record<string, unknown> = {}) => ({
  symbol: "MSF.DE",
  currency: "EUR",
  exchange: "GER",
  fullExchangeName: "XETRA",
  longName: "Microsoft Corporation",
  regularMarketPrice: 472.853,
  regularMarketTime: Date.UTC(2026, 9, 15, 8, 27),
  regularMarketChangePercent: null,
  marketState: "CLOSED",
  fetchedAt: "2026-10-15T08:30:00Z",
  stale: false,
  ...over,
});

const refetch = vi.fn();
function setup(
  opts: {
    listings?: unknown[] | "loading" | "error";
    destination?: string | null;
    quote?: unknown | null;
    signedOut?: boolean;
    target?: TradeTarget;
  } = {},
) {
  const listings = opts.listings ?? [row()];
  if (listings === "loading")
    mocks.handoffApi.getEurListings.mockReturnValue(new Promise(() => {}));
  else if (listings === "error")
    mocks.handoffApi.getEurListings.mockRejectedValue(new Error("boom"));
  else mocks.handoffApi.getEurListings.mockResolvedValue(listings);
  mocks.handoffApi.getDefaultDestination.mockResolvedValue(
    opts.destination === undefined ? "IBIS2" : opts.destination,
  );
  mocks.auth.useAuth.mockReturnValue(
    opts.signedOut
      ? { status: "signed-out", user: null, recovery: false }
      : { status: "signed-in", user: { id: "u1" }, recovery: false },
  );
  const quote = opts.quote === undefined ? eurQuote() : opts.quote;
  mocks.quotes.useQuotes.mockImplementation((symbols: readonly string[]) => ({
    data: symbols.length > 0 && quote !== null ? [quote] : undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TradeOnIbkrDialog open onOpenChange={() => {}} target={opts.target ?? TARGET} />
    </QueryClientProvider>,
  );
}

const badge = (status: string) =>
  waitFor(() =>
    expect(screen.getByTestId("listing-badge").getAttribute("data-status")).toBe(status),
  );
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const prompt = (): string => (screen.getByTestId("ibot-prompt") as HTMLTextAreaElement).value;

beforeEach(() => {
  vi.clearAllMocks();
  refetch.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("verified listing", () => {
  it("builds the owner's example prompt, with the checklist and the login link", async () => {
    setup();
    await badge("verified");
    expect(screen.getByText("MSF")).toBeTruthy();
    expect(screen.getByText("12178239")).toBeTruthy();
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(screen.getByTestId("ticket-checklist").textContent).toBe(
      "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2",
    );
    expect(screen.getByTestId("documented-prompt").textContent).toBe(
      "Buy 10 shares of MSF at 400 limit",
    );
    const link = screen.getByTestId("open-ibkr") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.interactivebrokers.com/sso/Login");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("estimate").textContent).toContain(
      "Estimate before fees: 4,000.00 EUR",
    );
  });

  it("shows the delayed Yahoo quote with its UTC timestamp, never as live, and prefills the limit price rounded to 2 decimals", async () => {
    setup();
    await badge("verified");
    const block = screen.getByTestId("quote-block").textContent ?? "";
    expect(block).toContain(
      "Delayed quote (Yahoo): 472.85 EUR as of 15 Oct 2026, 08:27 UTC, 15 minutes or more delayed, not an IBKR price",
    );
    expect(block.toLowerCase()).not.toContain("live");
    await waitFor(() =>
      expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("472.85"),
    );
    expect(screen.getByText("Prefilled from the delayed quote: edit before use.")).toBeTruthy();
    // typing a price takes over for good: a later quote does not overwrite it
    type("Limit price (EUR)", "400");
    expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("400");
    expect(screen.queryByText("Prefilled from the delayed quote: edit before use.")).toBeNull();
  });

  it("does not use a quote that is not in EUR", async () => {
    setup({ quote: eurQuote({ currency: "USD" }) });
    await badge("verified");
    expect(screen.getByText("Quote unavailable")).toBeTruthy();
    expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("");
  });

  it("limits the quote refresh with a 10 second cooldown", async () => {
    setup();
    await badge("verified");
    const button = screen.getByRole("button", { name: "Refresh quote" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Refresh quote (10 s)" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("omits the price for a market order and works for a sell", async () => {
    setup();
    await badge("verified");
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    type("Quantity (shares)", "3");
    expect(screen.queryByLabelText("Limit price (EUR)")).toBeNull();
    expect(prompt()).toBe("Create sell market order for 3 shares of MSF and set destination IBIS2");
  });

  it("rejects a decimal comma with an explanation instead of guessing, and shows no prompt", async () => {
    setup();
    await badge("verified");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "472,85");
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    expect(screen.getByRole("alert", { name: "" }).textContent).toContain("dot");
    expect(screen.getByTestId("prompt-gate").textContent).toBe(
      "Enter a limit price to show the prompt.",
    );
  });

  it("copies the prompt with the clipboard API and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await badge("verified");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-prompt"));
    });
    expect(writeText).toHaveBeenCalledWith(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(screen.getByTestId("copy-prompt").textContent).toBe("Copied");
  });
});

describe("destination (spec 13.3)", () => {
  it("pre-selects the profile default when it applies to the listing", async () => {
    setup({ destination: "IBIS" });
    await badge("verified");
    await waitFor(() =>
      expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("IBIS"),
    );
    expect(screen.queryByTestId("destination-note")).toBeNull();
  });

  it("falls back to IBIS2 for a signed-in user without a stored value", async () => {
    setup({ destination: null });
    await badge("verified");
    expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("IBIS2");
  });

  it("works without an account: a signed-out visitor gets IBIS2 and the profile is never read", async () => {
    setup({ destination: null, signedOut: true });
    await badge("verified");
    expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("IBIS2");
    expect(mocks.handoffApi.getDefaultDestination).not.toHaveBeenCalled();
    expect(screen.getByTestId("no-order-notice")).toBeTruthy();
  });

  it("pre-selects AEB and says why when only an AEB listing exists", async () => {
    setup({
      listings: [
        row({ exchange: "AEB", localSymbol: "ASML", conid: 117589399, eurSymbolYahoo: "ASML.AS" }),
      ],
      destination: "IBIS2",
    });
    await badge("verified");
    await waitFor(() =>
      expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("AEB"),
    );
    expect(screen.getByTestId("destination-note").textContent).toContain("IBIS2");
    expect(
      Array.from((screen.getByLabelText("Destination") as HTMLSelectElement).options).map(
        (o) => o.value,
      ),
    ).toEqual(["AEB"]);
  });

  it("labels IBIS2 as the owner's practice, not an IBKR catalogue code", async () => {
    setup();
    await badge("verified");
    const options = Array.from(
      (screen.getByLabelText("Destination") as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toEqual([
      "IBIS2 — Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)",
      "IBIS — Xetra",
    ]);
  });
});

describe("unverified listing (A-28)", () => {
  const unverified = row({
    status: "unverified",
    verifiedAt: null,
    eurSymbolYahoo: "MSF.DE",
    verification: {
      method: "automatic",
      failed: ["price_within_tolerance"],
      checks: { isin_confirmed: "pass", price_within_tolerance: "fail" },
    },
  });

  it("shows no prompt until the acknowledgement is ticked, then shows it", async () => {
    setup({ listings: [unverified] });
    await badge("unverified");
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be fully verified: EUR price within 1% of the screening listing",
    );
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    expect(screen.getByTestId("prompt-gate").textContent).toBe(
      "Tick the box above to show the prompt.",
    );
    fireEvent.click(screen.getByLabelText("I have checked this is the same share"));
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    fireEvent.click(screen.getByLabelText("I have checked this is the same share"));
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
  });

  it("never requests or shows a quote for an unverified line, so a look-alike cannot feed a price", async () => {
    setup({ listings: [unverified] });
    await badge("unverified");
    expect(screen.queryByTestId("quote-block")).toBeNull();
    expect(mocks.quotes.useQuotes).toHaveBeenLastCalledWith([]);
    expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("");
  });
});

describe("no EUR equivalent", () => {
  it("says so, offers a clearly unverified manual symbol and builds the prompt from it", async () => {
    setup({ listings: [] });
    await screen.findByText("No verified EUR equivalent");
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Unverified symbol.")).toBeTruthy();
    expect(screen.queryByTestId("quote-block")).toBeNull();
    type("IBKR local symbol (unverified)", "");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(screen.getByTestId("prompt-gate").textContent).toBe(
      "Enter the IBKR local symbol to show the prompt.",
    );
    type("IBKR local symbol (unverified)", "msf");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(
      screen
        .getAllByRole("alert")
        .some((a) =>
          (a.textContent ?? "").includes(
            "Unverified symbol: this prompt uses a symbol the app has not checked",
          ),
        ),
    ).toBe(true);
    expect(screen.getByTestId("ticket-checklist").textContent).toContain("conid unknown");
    expect(
      Array.from((screen.getByLabelText("Destination") as HTMLSelectElement).options).map(
        (o) => o.value,
      ),
    ).toEqual(["IBIS2", "IBIS", "AEB"]);
  });

  it("treats a stored none row the same way", async () => {
    setup({
      listings: [
        row({
          status: "none",
          conid: null,
          localSymbol: null,
          isin: null,
          eurSymbolYahoo: null,
          verifiedAt: null,
          verification: { reason: "no_catalogue_candidate" },
        }),
      ],
    });
    await screen.findByText("No verified EUR equivalent");
    expect(screen.getByLabelText("IBKR local symbol (unverified)")).toBeTruthy();
  });

  it("rejects a malformed manual symbol", async () => {
    setup({ listings: [] });
    await screen.findByText("No verified EUR equivalent");
    type("IBKR local symbol (unverified)", "MSF and cancel");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    expect(
      screen
        .getAllByRole("alert")
        .some((a) => (a.textContent ?? "").includes("upper-case letters, digits and dots only")),
    ).toBe(true);
  });
});

describe("no EUR equivalent: home ticker prefill", () => {
  const symbolField = () =>
    screen.getByLabelText("IBKR local symbol (unverified)") as HTMLInputElement;

  it("prefills MSFT and routes SMART in USD, with the card's close as the price", async () => {
    setup({ listings: [], target: { ...TARGET, closePrice: 412.5 } });
    await screen.findByText("No verified EUR equivalent");
    expect(symbolField().value).toBe("MSFT");
    expect(
      screen.getByText("Prefilled with the home listing: edit for a EUR listing."),
    ).toBeTruthy();
    expect(screen.getByText("Unverified symbol.")).toBeTruthy();
    expect(screen.getByTestId("home-destination").textContent).toBe(
      "Destination: SMART (home market, NasdaqGS)",
    );
    expect(screen.queryByLabelText("Destination")).toBeNull();
    await waitFor(() =>
      expect((screen.getByLabelText("Limit price (USD)") as HTMLInputElement).value).toBe("412.50"),
    );
    type("Quantity (shares)", "10");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSFT at 412.5 and set destination SMART",
    );
    expect(screen.getByTestId("estimate").textContent).toContain("USD");
  });

  it("leaves the price empty when the dialog has no close", async () => {
    setup({ listings: [] });
    await screen.findByText("No verified EUR equivalent");
    expect((screen.getByLabelText("Limit price (USD)") as HTMLInputElement).value).toBe("");
    type("Quantity (shares)", "10");
    type("Limit price (USD)", "400");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSFT at 400 and set destination SMART",
    );
  });

  it("prefills RMS for RMS.PA", async () => {
    setup({
      listings: [],
      target: { ...TARGET, symbol: "RMS.PA", exchangeCode: "PAR", currency: "EUR" },
    });
    await screen.findByText("No verified EUR equivalent");
    expect(symbolField().value).toBe("RMS");
  });

  it("restores the EUR behaviour once the user types another symbol, and does not prefill again", async () => {
    setup({ listings: [] });
    await screen.findByText("No verified EUR equivalent");
    type("IBKR local symbol (unverified)", "MSF");
    expect(
      screen.queryByText("Prefilled with the home listing: edit for a EUR listing."),
    ).toBeNull();
    expect(screen.queryByTestId("home-destination")).toBeNull();
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    type("IBKR local symbol (unverified)", "");
    expect(symbolField().value).toBe("");
  });

  it("does not prefill a verified listing", async () => {
    setup();
    await badge("verified");
    expect(screen.queryByLabelText("IBKR local symbol (unverified)")).toBeNull();
    expect(screen.getByLabelText("Destination")).toBeTruthy();
  });
});

describe("the no-orders notice (review focus 4)", () => {
  const notice = () => screen.getByTestId("no-order-notice").textContent;

  it("is shown while the listing loads, when it fails, and for every status", async () => {
    setup({ listings: "loading" });
    expect(notice()).toBe(NO_ORDER_NOTICE);
    expect(screen.getByTestId("listing-loading")).toBeTruthy();
    cleanup();

    setup({ listings: "error" });
    await screen.findByTestId("listing-error");
    expect(notice()).toBe(NO_ORDER_NOTICE);
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    cleanup();

    for (const [listings, wait] of [
      [[row()], "verified"],
      [[row({ status: "unverified", verifiedAt: null })], "unverified"],
      [[], "none"],
    ] as const) {
      setup({ listings: [...listings] });
      await badge(wait);
      expect(notice()).toBe(NO_ORDER_NOTICE);
      cleanup();
    }
  });

  it("is never worded like an order ticket: no submit or place-order control exists", async () => {
    setup();
    await badge("verified");
    const labels = screen.getAllByRole("button").map((b) => (b.textContent ?? "").toLowerCase());
    expect(labels.some((l) => /submit|place order|confirm order|send order/.test(l))).toBe(false);
    expect(screen.getByRole("heading", { name: "Trade on IBKR" })).toBeTruthy();
  });
});

describe("held instrument", () => {
  const HELD: HeldTarget = {
    kind: "held",
    symbol: "VUAA",
    listingExchange: "LSEETF",
    conid: 123456,
    description: "VANG S&P500 USDD",
    currency: "USD",
  };
  function setupHeld(target: HeldTarget = HELD) {
    mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
    mocks.auth.useAuth.mockReturnValue({
      status: "signed-in",
      user: { id: "u1" },
      recovery: false,
    });
    mocks.quotes.useQuotes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <TradeOnIbkrDialog open onOpenChange={() => {}} target={target} />
      </QueryClientProvider>,
    );
  }

  it("shows the held instrument as the destination, with no EUR lookup or verification panel", () => {
    setupHeld();
    expect(mocks.handoffApi.getEurListings).not.toHaveBeenCalled();
    expect(screen.getByTestId("held-instrument").textContent).toContain("VUAA");
    expect(screen.getByTestId("held-instrument").textContent).toContain("LSEETF");
    expect(screen.getByTestId("held-instrument").textContent).toContain("123456");
    expect(screen.queryByTestId("listing-badge")).toBeNull();
    expect(screen.queryByTestId("quote-block")).toBeNull();
    expect(screen.getByText(NO_ORDER_NOTICE)).toBeTruthy();
  });

  it("builds the prompt with the listing exchange and labels the price in the instrument's currency", () => {
    setupHeld();
    type("Quantity (shares)", "5");
    type("Limit price (USD)", "112.84");
    expect(prompt()).toBe(
      "Create buy limit order for 5 shares of VUAA at 112.84 and set destination LSEETF",
    );
  });

  it("falls back to SMART for an exchange code that is not an IBKR destination", () => {
    setupHeld({ ...HELD, listingExchange: "XYZQ" });
    type("Quantity (shares)", "5");
    type("Limit price (USD)", "10");
    expect(prompt()).toContain("set destination SMART");
    expect(screen.getByTestId("destination-note").textContent).toContain("XYZQ");
  });

  describe("Xetra preference", () => {
    const VUSA: HeldTarget = {
      ...HELD,
      symbol: "VUSA",
      listingExchange: "AEB",
      currency: "EUR",
      isin: "IE00B3XXRP09",
    };
    const rows = [
      { exchange: "AEB", conid: 222, localSymbol: "VUSA", currency: "EUR" },
      { exchange: "IBIS", conid: 111, localSymbol: "VUSD", currency: "EUR" },
    ];

    it("prefers Xetra with the user's IBIS2 default and shows the note", async () => {
      mocks.handoffApi.getCatalogueListings.mockResolvedValue(rows);
      setupHeld(VUSA);
      await waitFor(() => expect(screen.getByTestId("held-destination").textContent).toBe("IBIS2"));
      expect(screen.getByTestId("destination-note").textContent).toBe("Xetra preferred");
      type("Quantity (shares)", "5");
      type("Limit price (EUR)", "100");
      expect(prompt()).toBe(
        "Create buy limit order for 5 shares of VUSD at 100 and set destination IBIS2",
      );
    });

    it("shows Amsterdam when only AEB lists it", async () => {
      mocks.handoffApi.getCatalogueListings.mockResolvedValue([rows[0]]);
      setupHeld(VUSA);
      await waitFor(() =>
        expect(screen.getByTestId("destination-note").textContent).toBe(
          "Amsterdam (no Xetra listing found)",
        ),
      );
      expect(screen.getByTestId("held-destination").textContent).toBe("AEB");
    });

    it("shows a loading state while the lookup runs", () => {
      mocks.handoffApi.getCatalogueListings.mockReturnValue(new Promise(() => {}));
      setupHeld(VUSA);
      expect(screen.getByTestId("destination-loading")).toBeTruthy();
    });

    it("falls back silently to the statement exchange when the lookup fails", async () => {
      mocks.handoffApi.getCatalogueListings.mockRejectedValue(new Error("boom"));
      setupHeld(VUSA);
      await waitFor(() =>
        expect(screen.getByTestId("destination-note").textContent).toBe(
          "Listing exchange from your statement",
        ),
      );
      expect(screen.getByTestId("held-destination").textContent).toBe("AEB");
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});

describe("your position", () => {
  const POSITION = {
    quantity: 12,
    averageCost: 400.18,
    currency: "EUR",
    marketValue: { kind: "ok" as const, value: 5414.4, ccy: "EUR" },
    unrealized: { kind: "ok" as const, value: 612.3, ccy: "EUR" },
    heldSymbol: "MSF",
    heldExchange: "IBIS",
    reportDate: "2026-10-17",
  };
  function setupWith(target: TradeTarget | HeldTarget) {
    mocks.handoffApi.getEurListings.mockResolvedValue([row()]);
    mocks.handoffApi.getCatalogueListings.mockResolvedValue([]);
    mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
    mocks.auth.useAuth.mockReturnValue({
      status: "signed-in",
      user: { id: "u1" },
      recovery: false,
    });
    mocks.quotes.useQuotes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <TradeOnIbkrDialog open onOpenChange={() => {}} target={target} />
      </QueryClientProvider>,
    );
  }
  const HELD_TARGET: HeldTarget = {
    kind: "held",
    symbol: "VUAA",
    listingExchange: "LSEETF",
    conid: 123456,
    description: "VANG",
    currency: "USD",
  };

  it("shows the card for a screened and for a held target, and not without a position", async () => {
    const a = setupWith({ ...TARGET, position: POSITION });
    expect(screen.getByRole("region", { name: "Your position" })).toBeTruthy();
    a.unmount();
    const b = setupWith({ ...HELD_TARGET, position: POSITION });
    expect(screen.getByRole("region", { name: "Your position" })).toBeTruthy();
    b.unmount();
    setupWith(TARGET);
    await badge("verified");
    expect(screen.queryByRole("region", { name: "Your position" })).toBeNull();
    expect(screen.queryByText(/Use all/)).toBeNull();
  });

  it("offers Use all only on Sell, and it fills the quantity", async () => {
    setupWith({ ...TARGET, position: POSITION });
    await badge("verified");
    expect(screen.queryByRole("button", { name: "Use all 12 shares" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.click(screen.getByRole("button", { name: "Use all 12 shares" }));
    expect((screen.getByLabelText("Quantity (shares)") as HTMLInputElement).value).toBe("12");
  });

  it("uses the singular for one share", async () => {
    setupWith({ ...TARGET, position: { ...POSITION, quantity: 1 } });
    await badge("verified");
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(screen.getByRole("button", { name: "Use all 1 share" })).toBeTruthy();
    type("Quantity (shares)", "3");
    expect(screen.getByText(/short position/).textContent).toBe(
      "You hold 1 share. Selling 3 would open a short position of 2.",
    );
  });

  it("warns about a short position only above the held quantity and never blocks the prompt", async () => {
    setupWith({ ...TARGET, position: POSITION });
    await badge("verified");
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    type("Limit price (EUR)", "400");
    type("Quantity (shares)", "12");
    expect(screen.queryByText(/short position/)).toBeNull();
    type("Quantity (shares)", "10");
    expect(screen.queryByText(/short position/)).toBeNull();
    type("Quantity (shares)", "15");
    expect(screen.getByText(/short position/).textContent).toBe(
      "You hold 12 shares. Selling 15 would open a short position of 3.",
    );
    expect(prompt()).toContain("sell limit order for 15 shares");
  });

  it("offers no Use all for a fractional holding and words the warning without float noise", async () => {
    setupWith({ ...TARGET, position: { ...POSITION, quantity: 12.3 } });
    await badge("verified");
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    expect(screen.queryByText(/Use all/)).toBeNull();
    type("Quantity (shares)", "15");
    expect(screen.getByText(/short position/).textContent).toBe(
      "You hold 12.3 shares. Selling 15 would open a short position of 2.7.",
    );
  });

  it("shows no warning on Buy", async () => {
    setupWith({ ...TARGET, position: POSITION });
    await badge("verified");
    type("Quantity (shares)", "50");
    expect(screen.queryByText(/short position/)).toBeNull();
  });
});
