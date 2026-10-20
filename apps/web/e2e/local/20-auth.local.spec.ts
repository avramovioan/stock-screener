/**
 * Auth flows against the real local Supabase Auth: the invite-only first sign-in (create a password), sign-out, guards, sign-in with the
 * original target, the Security page, an off-origin `next`, "Not possible yet" for an e-mail that is not on the list, and the guard matrix.
 * This spec invites its own random users through the service role; the sign-ins of the other specs stay below the local limit of
 * 30 sign-ins per 5 minutes per IP configured in supabase/config.toml.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_PASSWORD } from "../../../../tools/lib/e2e-env.ts";
import { invite, OWNER, signIn, uninvite } from "./support/stack";

test("an invited friend creates a password, uses a protected page, signs out, signs in again, opens Security", async ({
  page,
}) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const header = page.getByRole("banner");
  await invite(email);

  // step 1 finds the e-mail on the list without a password: create one and land on the Overview
  await page.goto("/auth/sign-in");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Create your password" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create password and sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(header.getByRole("link", { name: "Profile" })).toBeVisible();

  // a protected page renders while signed in
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Portfolio" })
    .click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();

  // sign out
  await header.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth\/signed-out$/);
  await expect(header.getByRole("link", { name: "Sign in" })).toBeVisible();

  // a deep link to a protected page redirects, and never flashes the page
  await page.goto("/portfolio");
  await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fportfolio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toHaveCount(0);

  // sign in again lands on the original target
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();

  // Profile -> Security: email, verified badge, password form (this account has an email identity)
  await header.getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile\/security$/);
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  await expect(page.getByText(/there is no password to change/)).toHaveCount(0);

  // an off-origin `next` is ignored after sign-in
  await header.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth\/signed-out$/);
  await page.goto("/auth/sign-in?next=https%3A%2F%2Fevil.example.com%2Fphish");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  expect(new URL(page.url()).hostname).toBe("localhost");
  await uninvite(email);
});

test("a wrong password shows an error and keeps the visitor on the sign-in page", async ({
  page,
}) => {
  await page.goto("/auth/sign-in");
  await page.getByLabel("E-mail").fill(OWNER.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill("Definitely-Wrong-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});

test("an e-mail that is not on the list gets only Not possible yet", async ({ page }) => {
  await page.goto("/auth/sign-in");
  await page.getByLabel("E-mail").fill(`stranger-${randomUUID()}@example.com`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Not possible yet" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
});

test("the sign-up, Google and password-reset ways in are gone", async ({ page }) => {
  for (const path of ["/auth/sign-up", "/auth/reset", "/auth/callback"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  }
  await page.goto("/auth/sign-in");
  await expect(page.getByRole("button", { name: /google/i })).toHaveCount(0);
});

test("every guarded route redirects a signed-out visitor to sign-in and never renders the page", async ({
  page,
}) => {
  for (const path of ["/portfolio", "/analytics", "/profile/security", "/profile/broker"]) {
    await page.goto(path);
    await page.waitForURL(/\/auth\/sign-in/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    await expect(
      page.getByRole("heading", { level: 1, name: /^(Portfolio|Analytics)$/ }),
    ).toHaveCount(0);
  }
});

test("the e2e owner opens every guarded page after signing in", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL("/");
  const pages = [
    ["/portfolio", "Portfolio"],
    ["/analytics", "Analytics"],
    ["/profile/security", "Security"],
    ["/profile/broker", "Broker"],
  ] as const;
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
});
