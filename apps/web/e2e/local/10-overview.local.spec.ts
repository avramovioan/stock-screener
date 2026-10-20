/**
 * Local-stack end-to-end spec (P7 Task 4). Setup, once per session (PowerShell, repository root):
 *   bun run e2e:setup        # supabase start, db reset, users, fixture Flex statement, fixture scan, portfolio_scan checks
 *   bun run test:e2e:local   # ensures the seed, starts the Vite dev server on 5173, runs every spec in e2e/local
 * The Edge Functions are the ones `supabase start` serves, configured by supabase/functions/.env (see tools/e2e-setup.ts).
 * The service-role key reaches these specs through E2E_SERVICE_ROLE_KEY and never reaches the browser bundle.
 *
 * Anonymous Overview and Quotes against the real stack: no API stubs. Market data comes from the chart and quote cache rows that
 * tools/e2e-setup.ts seeds (no Yahoo access).
 */
import { expect, test } from "@playwright/test";
import { ANON, api, feedRows, trackWrites } from "./support/stack";

test("Overview shows the last successful scan time in Sofia time", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Last scan \w{3} \d{1,2}, \d{2}:\d{2} Sofia time/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Today's discounts" })).toBeVisible();
});

test("Overview shows the fixture scan's discount cards, each with a graph link and a state", async ({
  page,
}) => {
  const rows = await feedRows();
  expect(rows.length, "the fixture scan published cards (bun run e2e:setup)").toBeGreaterThan(0);
  await page.goto("/");
  const cards = page.getByTestId("discount-card");
  await expect(cards.first()).toBeVisible();
  // every row is a card: one grid (cleared, caution, pending, then flagged)
  await expect(cards).toHaveCount(rows.length);
  for (const card of await cards.all()) {
    await expect(card.getByRole("link", { name: "Show on graph" })).toBeVisible();
    await expect(card).toHaveAttribute("data-state", /^(cleared|caution|pending|flagged)$/);
  }
  await expect(page.locator("details")).toHaveCount(0);
});

test("every non-flagged card carries the tag its feed row implies; the rank #6 JPM card never says Strong buy under the gauge", async ({
  page,
}) => {
  const rows = await feedRows();
  expect(rows.length, "the fixture scan published cards (bun run e2e:setup)").toBeGreaterThan(0);
  await page.goto("/");
  for (const row of rows) {
    const card = page.locator(`[data-testid="discount-card"][data-symbol="${row.yahoo_symbol}"]`);
    await expect(card).toBeVisible();
    if ((await card.getAttribute("data-state")) === "flagged") {
      await expect(card.getByTestId("discount-tag")).toHaveCount(0);
      await expect(card.getByText("Strong buy")).toHaveCount(0);
      continue;
    }
    const tag = row.reached_line4 ? "reached" : "wait";
    await expect(card.getByTestId("discount-tag")).toHaveAttribute("data-tag", tag);
  }
  const jpm = rows.find((r) => r.yahoo_symbol === "JPM");
  if (jpm && jpm.operational_category !== "red" && jpm.operational_category !== "grey") {
    expect(jpm.rank).toBe(6);
    const card = page.locator('[data-testid="discount-card"][data-symbol="JPM"]');
    await expect(card.getByTestId("discount-tag").getByText("Strong buy")).toHaveCount(0);
  }
});

test("cards and The Company List show the country with its flag", async ({ page }) => {
  const rows = await feedRows();
  const first = rows.find((r) => r.country !== null);
  expect(first, "a feed row with a country").toBeTruthy();
  await page.goto("/");
  const card = page.locator(`[data-testid="discount-card"][data-symbol="${first?.yahoo_symbol}"]`);
  await expect(card).toContainText(`${first?.country} ·`);
  await expect(card.locator("svg[data-flag]").first()).toBeVisible();
  const row = page.getByTestId("company-row").or(page.getByTestId("company-card")).first();
  await expect(row.locator("svg[data-flag]").first()).toBeVisible();
});

test("Listed in filters the cards and the list and keeps ?country=us in the URL", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  const group = page.getByRole("radiogroup", { name: "Listed in" });
  await expect(group.getByRole("radio", { name: "All exchanges" })).toBeChecked();
  await group.getByText("United States", { exact: true }).click();
  await expect(page).toHaveURL(/\?country=us$/);
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  for (const row of await page.getByTestId("company-row").all()) {
    await expect(row).toContainText("United States");
  }
  for (const card of await page.getByTestId("discount-card").all()) {
    await expect(card).toContainText("United States.");
  }
  await group.getByText("All exchanges", { exact: true }).click();
  await expect(page).not.toHaveURL(/country=/);
});

test("The Company List shows 15 rows, then Load more appends further rows", async ({ page }) => {
  const anon = await api(ANON);
  const first = await anon.post("/rest/v1/rpc/company_list", {
    data: { p_mode: "worldwide", p_limit: 100, p_after_rank: null },
  });
  const total = first.ok() ? ((await first.json()) as unknown[]).length : 0;
  await anon.dispose();
  expect(total, "the fixture scan published a company list (bun run e2e:setup)").toBeGreaterThan(0);
  await page.goto("/");
  await expect(page.getByTestId("company-row")).toHaveCount(Math.min(15, total));
  if (total > 15) {
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByTestId("company-row")).toHaveCount(Math.min(40, total));
  } else {
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  }
});

test("everyone reads the worldwide ranking: ?mode= is ignored, the filter is open to all, no write", async ({
  page,
}) => {
  const writes = trackWrites(page);
  const modes: string[] = [];
  page.on("request", (req) => {
    const body =
      req.method() === "POST" ? (req.postDataJSON() as { p_mode?: string } | null) : null;
    if (body?.p_mode) modes.push(body.p_mode);
  });
  await page.goto("/?mode=us");
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Listed in" })).toBeVisible();
  expect(modes.length).toBeGreaterThan(0);
  expect(new Set(modes)).toEqual(new Set(["worldwide"]));
  expect(writes).toEqual([]);
});

test("Show on graph opens /quotes with the symbol, a chart canvas, both external links and the attribution", async ({
  page,
}) => {
  expect(
    (await feedRows()).some((r) => !r.withheld),
    "a cleared card exists",
  ).toBe(true);
  await page.goto("/");
  const link = page.getByRole("link", { name: "Show on graph" }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/quotes\?.*symbol=/);
  const symbol = new URL(page.url()).searchParams.get("symbol") ?? "";
  expect(symbol).not.toBe("");
  await expect(page.locator("canvas").first()).toBeVisible();
  const yahoo = page.getByRole("link", { name: "View on Yahoo Finance" });
  await expect(yahoo).toHaveAttribute(
    "href",
    `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
  );
  await expect(yahoo).toHaveAttribute("rel", "noopener noreferrer");
  await expect(yahoo).toHaveAttribute("target", "_blank");
  const tv = page.getByRole("link", { name: "View on TradingView" });
  await expect(tv).toHaveAttribute(
    "href",
    /^https:\/\/www\.tradingview\.com\/symbols\/[A-Z]+-[^/]+\/$/,
  );
  await expect(tv).toHaveAttribute("target", "_blank");
  await expect(tv).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByText(/TradingView Lightweight Charts/).first()).toBeVisible();
});

test("Quotes opens by deep link for a signed-out visitor and prints the last close", async ({
  page,
}) => {
  await page.goto("/quotes?symbol=AAPL");
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByText(/Last completed close/)).toBeVisible();
});
