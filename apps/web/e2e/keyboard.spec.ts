import { expect, test } from "@playwright/test";
import { stubApi } from "./support/stub-api";

test.use({ serviceWorkers: "block" });

async function focusLabel(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    if (!e) return null;
    const cs = getComputedStyle(e);
    return {
      label: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 60),
      ring: cs.outlineStyle !== "none" || cs.boxShadow !== "none",
    };
  });
}

test("Overview: every main control is reachable by Tab and shows a focus ring", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  await expect(page.getByTestId("company-row").first()).toBeVisible();
  const seen = new Map<string, boolean>();
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    const f = await focusLabel(page);
    if (f?.label) seen.set(f.label, f.ring);
  }
  for (const wanted of ["Show on graph", "Load more"]) {
    const key = [...seen.keys()].find((k) => k.startsWith(wanted));
    expect(key, `${wanted} should be reachable with Tab`).toBeTruthy();
    expect(seen.get(key as string), `${wanted} should show a focus indicator`).toBe(true);
  }
});

test("Quotes: range buttons move with arrow keys and the selector is a labelled control", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/quotes?symbol=MSFT");
  await expect(page.getByLabel("Select a stock from today")).toBeVisible();
  await page.getByRole("button", { name: "1D" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "5D" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("Escape closes the short-summary popover and returns focus to its button", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Added today: 1/ });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Added today" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Added today" })).toBeHidden();
  await expect(trigger).toBeFocused();
});
