import { expect, test } from "@playwright/test";
import { stubAccess } from "./support/stub-api";

test("home page renders the shell and the primary navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Stock Screener/);
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const label of ["Overview", "Quotes", "Portfolio", "Analytics"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Today's discounts" })).toBeVisible();
});

test("a deep link falls back to the SPA shell", async ({ page }) => {
  await page.goto("/quotes");
  await expect(page.getByRole("heading", { level: 1, name: "Quotes" })).toBeVisible();
});

test("manifest and service worker are served from the site root", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe("Stock Screener");
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(sw.headers()["content-type"]).toContain("javascript");
});

test("the service worker registers with scope /", async ({ page }) => {
  await page.goto("/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/");
});

test("the theme choice persists after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Theme/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("the notifications bell is in the header for a visitor who is not signed in", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.getByRole("banner").first();
  await expect(header.getByRole("button", { name: "Notifications on this device" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("sign-in asks for the e-mail only and offers no sign-up or Google", async ({ page }) => {
  await stubAccess(page, "not_possible");
  await page.goto("/auth/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("E-mail")).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /google/i })).toHaveCount(0);
  await page.getByLabel("E-mail").fill("stranger@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Not possible yet" })).toBeVisible();
});
