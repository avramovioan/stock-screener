import { expect, test } from "@playwright/test";
import { DISCOUNTS, stubApi } from "./support/stub-api";

test.use({ serviceWorkers: "block" });

const card = (page: import("@playwright/test").Page, symbol: string) =>
  page.locator(`[data-testid="discount-card"][data-symbol="${symbol}"]`);

test("a top 10 row reads Reached \u22124 under the gauge, with no Strong buy there", async ({
  page,
}) => {
  await stubApi(page);
  // The tag is factual (reached_line4); the shared fixture keeps MSFT above its -4 line, so this top 10 row is closed at it here.
  const feed = DISCOUNTS.map((d) =>
    (d as Record<string, unknown>).security_id === "sid-msft"
      ? { ...d, close: 398, reached_line4: true }
      : d,
  );
  await page.route("**/rest/v1/rpc/todays_discounts_feed", (r) =>
    r.request().method() === "OPTIONS"
      ? r.fulfill({
          status: 204,
          headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
        })
      : r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, json: feed }),
  );
  await page.goto("/");
  const msft = card(page, "MSFT");
  await expect(msft.getByTestId("discount-tag")).toHaveAttribute("data-tag", "reached");
  await expect(msft.getByTestId("discount-tag").getByText("Strong buy")).toHaveCount(0);
  await expect(msft.getByText("A top 10 company at or below its \u22123 line.")).toHaveCount(0);
});

test("rank 11 and below at the \u22124 line shows Reached, and the gauge marks both lines", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  const pend = card(page, "PEND");
  await expect(pend.getByTestId("discount-tag")).toHaveAttribute("data-tag", "reached");
  await expect(pend.getByText("Reached \u22124")).toBeVisible();
  await expect(pend.getByText("\u22124 $400.00")).toBeVisible();
  await expect(pend.getByText("\u22123 $415.00")).toBeVisible();
  await expect(pend.getByRole("figure")).toHaveAttribute(
    "aria-label",
    /below its \u22123 line of \$415\.00 and .* below its \u22124 line of \$400\.00/,
  );
});

test("a flagged top 10 row never shows Strong buy, and keeps its line tag", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  const red = card(page, "REDX");
  await expect(red).toHaveAttribute("data-state", "flagged");
  await expect(red.getByText("Strong buy")).toHaveCount(0);
  await expect(red.getByTestId("discount-tag")).toHaveCount(1);
  await expect(red.getByTestId("verdict-tag")).toHaveText("Avoid");
});

test("rank 11 and below between the two lines shows Wait for −4 under the gauge", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  const wait = card(page, "WAIT");
  await expect(wait.getByTestId("discount-tag")).toHaveAttribute("data-tag", "wait");
  await expect(wait.getByText("Wait for −4", { exact: true })).toBeVisible();
  await expect(wait.getByText(/^The −4 line, \$400\.00, is \d+(\.\d)?% lower\.$/)).toBeVisible();
  await expect(wait.getByTestId("discount-tag").getByText("Strong buy")).toHaveCount(0);
});
