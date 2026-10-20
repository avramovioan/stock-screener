import { expect, test } from "@playwright/test";
import { OTHER, OWNER, pageErrors, signIn } from "./support/stack";

test("Profile pages render for a signed-in user and the broker form never autocompletes the Flex token", async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, OTHER);
  await expect(page).toHaveURL("/");
  for (const [path, heading] of [
    ["/profile/security", "Security"],
    ["/profile/broker", "Broker"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
  await page.goto("/profile/broker");
  const token = page.getByLabel(/flex token/i);
  await expect(token).toHaveAttribute("autocomplete", "off");
  await expect(token).toHaveValue("");
  expect(errors).toEqual([]);
});

test("the linked owner's broker page never shows token material", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/profile/broker");
  await expect(page.getByText("Connection status")).toBeVisible();
  await expect(page.getByText("Linked", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not linked")).toHaveCount(0);
  await expect(page.getByText("Account", { exact: true })).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/flex_token|ciphertext|FLEX_ENC/i);
});
