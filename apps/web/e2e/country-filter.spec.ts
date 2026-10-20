import { expect, test } from "@playwright/test";
import { signInThroughForm, stubApi, stubSignedIn } from "./support/stub-api";

test.use({ serviceWorkers: "block" });

function recordModes(page: import("@playwright/test").Page) {
  const modes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().includes("/rest/v1/rpc/")) return;
    const body = req.postDataJSON() as { p_mode?: string } | null;
    if (body?.p_mode) modes.push(body.p_mode);
  });
  return modes;
}

const cardOrder = (page: import("@playwright/test").Page) =>
  page
    .getByTestId("discount-card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-symbol")));

test("everyone reads the one worldwide ranking: Listed in defaults to All exchanges and ?mode= is ignored", async ({
  page,
}) => {
  await stubApi(page);
  const modes = recordModes(page);
  await page.goto("/?mode=us");
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  const group = page.getByRole("radiogroup", { name: "Listed in" });
  await expect(group.getByRole("radio", { name: "All exchanges" })).toBeChecked();
  await expect(group.getByRole("radio", { name: "United States" })).not.toBeChecked();
  expect(modes.length).toBeGreaterThan(0);
  expect(new Set(modes)).toEqual(new Set(["worldwide"]));
  expect(await cardOrder(page)).toEqual([
    "MSFT",
    "ASML.AS",
    "7203.T",
    "WAIT",
    "AMBR",
    "PEND",
    "REDX",
  ]);
});

test("choosing United States filters the cards and the list, and keeps ?country=us in the URL", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  await expect(
    page.getByText(/^6 companies closed at or below their −3 line, 1 of them at its −4 line/),
  ).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Listed in" })
    .getByText("United States", { exact: true })
    .click();
  await expect(page).toHaveURL(/\?country=us$/);
  await expect(
    page.getByText(/^3 US companies closed at or below their −3 line, 1 of them at its −4 line/),
  ).toBeVisible();
  expect(await cardOrder(page)).toEqual(["MSFT", "AMBR", "PEND", "REDX"]);
  // 15 matching rows: the second page is fetched on the client until enough rows pass the filter
  await expect(page.getByTestId("company-row")).toHaveCount(15);
  for (const row of await page.getByTestId("company-row").all()) {
    await expect(row).toContainText("United States");
  }
  await page
    .getByRole("radiogroup", { name: "Listed in" })
    .getByText("All exchanges", { exact: true })
    .click();
  await expect(page).not.toHaveURL(/country=/);
  expect(await cardOrder(page)).toEqual([
    "MSFT",
    "ASML.AS",
    "7203.T",
    "WAIT",
    "AMBR",
    "PEND",
    "REDX",
  ]);
});

test("a ?country=us link opens on the United States view", async ({ page }) => {
  await stubApi(page);
  await page.goto("/?country=us");
  await expect(
    page
      .getByRole("radiogroup", { name: "Listed in" })
      .getByRole("radio", { name: "United States" }),
  ).toBeChecked();
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  expect(await cardOrder(page)).toEqual(["MSFT", "AMBR", "PEND", "REDX"]);
});

test("the control is the same for a signed-in user: no Profile link and no Preferences tab", async ({
  page,
}) => {
  await stubApi(page);
  await stubSignedIn(page);
  await signInThroughForm(page);
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Listed in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Change in Profile" })).toHaveCount(0);
  await page.goto("/profile/security");
  const nav = page.getByRole("navigation", { name: "Profile sections" });
  await expect(nav.getByRole("link", { name: "Broker" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Preferences" })).toHaveCount(0);
});
