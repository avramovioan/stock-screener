import { expect, test } from "@playwright/test";
import { stubApi } from "./support/stub-api";

test.use({ serviceWorkers: "block" });

const noHorizontalScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe("360 px wide", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("no horizontal page scroll on any public page", async ({ page }) => {
    await stubApi(page);
    for (const path of ["/", "/quotes?symbol=MSFT", "/about"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(await noHorizontalScroll(page), `${path} must not scroll horizontally`).toBe(true);
    }
  });

  test("the company list is stacked cards with every field, and Load more still works", async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("company-card")).toHaveCount(15);
    await expect(page.getByRole("table")).toHaveCount(0);
    const first = page.getByTestId("company-card").first();
    await expect(first).toContainText("Company 1");
    await expect(first).toContainText("United States, T1");
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByTestId("company-card")).toHaveCount(40);
  });

  test("the chart fits the viewport", async ({ page }) => {
    await stubApi(page);
    await page.goto("/quotes?symbol=MSFT");
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(360);
  });
});

test.describe("1280 px wide", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the company list is a real table with 15 rows, then 40 after Load more", async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByTestId("company-row")).toHaveCount(15);
    await expect(page.getByTestId("company-card")).toHaveCount(0);
    for (const name of ["Rank", "Company", "Country", "Price", "Today", "Market cap"]) {
      await expect(page.getByRole("columnheader", { name })).toBeVisible();
    }
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByTestId("company-row")).toHaveCount(40);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("top ten rows are marked, cards are ordered cleared, caution, pending, the red result is last in the one grid with the Avoid tag", async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("company-row").nth(9)).toHaveAttribute(
      "aria-description",
      "Top 10",
    );
    await expect(page.getByTestId("company-row").nth(10)).not.toHaveAttribute(
      "aria-description",
      "Top 10",
    );
    const order = await page
      .getByTestId("discount-card")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-symbol")));
    expect(order).toEqual(["MSFT", "ASML.AS", "7203.T", "WAIT", "AMBR", "PEND", "REDX"]);
    await expect(page.getByRole("heading", { name: "Flagged" })).toHaveCount(0);
    await expect(
      page.locator('[data-testid="discount-card"][data-symbol="REDX"]').getByTestId("verdict-tag"),
    ).toHaveText("Avoid");
    await expect(page.locator("details")).toHaveCount(0);
  });

  test("no horizontal page scroll", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
