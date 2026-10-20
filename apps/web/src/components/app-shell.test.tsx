import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileApi } from "@/features/profile/default";
import { signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

vi.mock("@/features/screening/api", () => ({
  fetchScanStatus: vi.fn().mockResolvedValue(null),
  fetchTodaysDiscounts: vi.fn().mockResolvedValue([]),
  fetchCompanyList: vi.fn().mockResolvedValue([]),
  fetchShortSummary: vi.fn().mockResolvedValue({
    as_of: null,
    added_today: [],
    removed_today: [],
    added_7d: [],
    removed_7d: [],
  }),
  fetchPriceSeries: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/features/screening/quotes-api", () => ({
  fetchQuotes: vi.fn().mockResolvedValue([]),
  searchSymbols: vi.fn().mockResolvedValue([]),
  fetchChartBySymbol: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.mocked(profileApi.getProfile).mockResolvedValue({
    userId: "user-1",
    displayName: null,
  });
});

const PUBLIC_ROUTES: Array<[string, string]> = [
  ["/", "Today's discounts"],
  ["/quotes", "Quotes"],
  ["/about", "About"],
  ["/auth/sign-in", "Sign in"],
  ["/auth/signed-out", "You are signed out"],
  ["/no-such-page", "Page not found"],
];

const PROTECTED_ROUTES: Array<[string, string]> = [
  ["/portfolio", "Portfolio"],
  ["/analytics", "Analytics"],
  ["/profile", "Security"],
  ["/profile/security", "Security"],
  ["/profile/broker", "Broker"],
  ["/profile/notifications", "Notifications"],
];

describe("app shell", () => {
  it.each(PUBLIC_ROUTES)(
    "public route %s renders the heading %s when signed out",
    async (path, heading) => {
      await renderApp(path, signedOut);
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    },
  );

  it.each(PROTECTED_ROUTES)(
    "protected route %s renders the heading %s when signed in",
    async (path, heading) => {
      await renderApp(path, signedIn());
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    },
  );

  it("renders primary and mobile navigation with the current page marked", async () => {
    await renderApp("/quotes", signedOut);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const mobile = screen.getByRole("navigation", { name: "Mobile" });
    for (const nav of [primary, mobile]) {
      const labels = within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim());
      expect(labels).toEqual(["Overview", "Quotes", "Portfolio", "Analytics"]);
      expect(within(nav).getByRole("link", { name: "Quotes" }).getAttribute("aria-current")).toBe(
        "page",
      );
    }
  });

  it("exposes landmarks, a skip link, the profile link and the theme toggle when signed in", async () => {
    await renderApp("/", signedIn());
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Theme/ })).toBeTruthy();
  });

  it.each([
    ["signed out", signedOut],
    ["signed in", signedIn()],
  ])("shows the notifications bell in the header when %s", async (_name, state) => {
    await renderApp("/", state);
    const header = within(screen.getAllByRole("banner")[0] as HTMLElement);
    const bell = await header.findByRole("button", { name: "Notifications on this device" });
    expect(bell).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("footer carries the data disclaimer, the TradingView attribution and the About link", async () => {
    await renderApp("/", signedOut);
    const footer = await screen.findByRole("contentinfo");
    expect(footer.textContent).toMatch(/delayed/i);
    expect(footer.textContent).toMatch(/not financial advice/i);
    expect(footer.textContent).toContain("TradingView Lightweight Charts");
    expect(footer.textContent).toContain("TradingView, Inc.");
    expect(within(footer).getByRole("link", { name: "About" }).getAttribute("href")).toBe("/about");
    const tv = within(footer).getByRole("link", { name: /tradingview\.com/i }) as HTMLAnchorElement;
    expect(tv.getAttribute("href")).toBe("https://www.tradingview.com/");
  });

  it("keeps Overview active with search params and only there", async () => {
    await renderApp("/?country=us", signedOut);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(
      within(primary).getByRole("link", { name: "Overview" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(primary).getByRole("link", { name: "Quotes" }).getAttribute("aria-current"),
    ).toBeNull();
  });
});
