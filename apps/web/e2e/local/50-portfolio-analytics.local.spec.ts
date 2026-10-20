import { expect, test } from "@playwright/test";
import { api, OTHER, OWNER, pageErrors, SERVICE, signIn, userId } from "./support/stack";

/** The manual refresh queues a broker_sync_runs row that nothing processes locally (the Vault secrets are gone after a db reset). Left behind it keeps /profile/broker in an active, spinning state and the 60 s cooldown set for later specs and reruns. */
test.afterAll(async () => {
  const owner = await userId(OWNER.email);
  const svc = await api(SERVICE);
  const runs = await svc.delete(
    `/rest/v1/broker_sync_runs?user_id=eq.${owner}&kind=eq.manual&state=in.(queued,requested,polling,parsing)`,
  );
  expect(runs.ok(), "the queued manual run is removed").toBe(true);
  const conn = await svc.patch(`/rest/v1/broker_connections?user_id=eq.${owner}`, {
    data: { last_manual_refresh_at: null },
  });
  expect(conn.ok(), "the manual-refresh cooldown is cleared").toBe(true);
  await svc.dispose();
});

test("the owner's Portfolio shows the fixture positions, the valuation tags of portfolio_scan and a manual refresh that enters its cooldown", async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, OWNER);
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
  await expect(page.getByTestId("positions-table")).toBeVisible();
  const tickers = await page
    .locator('[data-testid="row-ticker"], [data-testid="card-ticker"]')
    .allTextContents();
  expect(tickers.join(" ")).toMatch(/AAPL/);
  // tools/e2e-setup.ts asserted the tags in the database: AAPL is above the +2 line, SHEL has no scan data
  await expect(
    page
      .getByTestId("row-AAPL")
      .getByTestId(/^valuation-/)
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId("row-AAPL").getByTestId("valuation-extra_premium")).toBeVisible();
  const refresh = page.getByRole("button", { name: /refresh/i }).first();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(refresh).toBeDisabled();
  expect(errors).toEqual([]);
});

test("the owner's Analytics page renders from the fixture statement", async ({ page }) => {
  const errors = pageErrors(page);
  await signIn(page, OWNER);
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  // content derived from the fixture statement: the closed-lot count of the realized P&L, the per-currency rows and the NAV chart
  await expect(page.getByText(/Re-summed from \d+ closed lots?/)).toBeVisible();
  const perCurrency = page.getByRole("table", { name: "Per-currency breakdown" });
  await expect(perCurrency).toContainText("USD");
  await expect(perCurrency).toContainText("GBP");
  await expect(page.getByRole("figure", { name: /Net asset value in EUR/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a user without a broker sees the link prompt, not positions", async ({ page }) => {
  await signIn(page, OTHER);
  await page.goto("/portfolio");
  await expect(page.locator('a[href="/profile/broker"]').first()).toBeVisible();
  await expect(page.getByTestId("positions-table")).toHaveCount(0);
});

test("an info box opens from the Price header and from a price cell, one at a time", async ({
  page,
}) => {
  await signIn(page, OWNER);
  await page.goto("/portfolio");
  const table = page.getByTestId("positions-table");
  await table.getByRole("button", { name: "About the price" }).click();
  await expect(page.getByRole("dialog", { name: "About the price" })).toBeVisible();
  await table
    .getByTestId("row-AAPL")
    .getByRole("button", { name: "Price details for AAPL" })
    .click();
  await expect(page.getByRole("dialog", { name: "Price details for AAPL" })).toContainText(
    "Calculated by this app",
  );
  await expect(page.getByRole("dialog", { name: "About the price" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Trade is the last column and every row has a Trade on IBKR button", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/portfolio");
  const table = page.getByTestId("positions-table");
  await expect(table.getByRole("columnheader").last()).toHaveText("Trade");
  const rows = table.locator("tbody tr");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++)
    await expect(rows.nth(i).getByRole("button", { name: "Trade on IBKR" })).toBeVisible();
});

// Needs an unscreened ETF line (for example VUAA on LSEETF) in the fixture statement; add it to tools/e2e-setup.ts first.
test.fixme("an unscreened ETF row says Not screened and opens the hand-off with its own listing exchange", async ({
  page,
}) => {
  await signIn(page, OWNER);
  await page.goto("/portfolio");
  const row = page.getByTestId("row-VUAA");
  await expect(row.getByText("Not screened")).toBeVisible();
  await row.getByRole("button", { name: "Trade on IBKR" }).click();
  await expect(page.getByTestId("held-instrument")).toContainText("LSEETF");
  await expect(page.getByTestId("listing-badge")).toHaveCount(0);
});

test("the trade history filters narrow the list and live in the address", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/portfolio?q=AAPL&side=BUY");
  await expect(page.getByLabel("Symbol or name")).toHaveValue("AAPL");
  await expect(page.getByText(/^\d+ executions? match/)).toBeVisible();
  for (const symbol of await page.getByTestId("trade-symbol").allTextContents())
    expect(symbol).toBe("AAPL");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/q=AAPL/);
});
