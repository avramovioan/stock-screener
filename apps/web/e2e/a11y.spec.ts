import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { stubApi } from "./support/stub-api";

// page.route cannot see requests re-issued by the service worker
test.use({ serviceWorkers: "block" });

const PAGES = [
  { name: "Overview", path: "/", ready: "The Company List" },
  { name: "Quotes", path: "/quotes?symbol=MSFT", ready: "Microsoft Corporation (MSFT)" },
  { name: "About", path: "/about", ready: "About" },
];

for (const scheme of ["light", "dark"] as const) {
  for (const p of PAGES) {
    test(`axe (${scheme}): ${p.name} has no serious or critical violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubApi(page);
      await page.goto(p.path);
      await expect(page.getByRole("heading", { name: p.ready })).toBeVisible();
      if (p.name === "Quotes") await expect(page.locator("canvas").first()).toBeVisible();
      if (p.name === "Overview")
        await expect(page.getByTestId("company-row").first()).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
      expect(blocking).toEqual([]);
    });
  }
}

// The redesigned Overview (cards in every state, the Flagged group, the country filter, the list) at phone and desktop width
const VIEWPORTS = [
  { name: "360", width: 360, height: 740 },
  { name: "1280", width: 1280, height: 800 },
] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const viewport of VIEWPORTS) {
    for (const path of ["/", "/?country=us"]) {
      test(`axe (${scheme}, ${viewport.name}px): Overview ${path} has no serious or critical violations`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme });
        await stubApi(page);
        await page.goto(path);
        await expect(page.getByTestId("discount-card").first()).toBeVisible();
        await expect(
          page.getByTestId("company-row").or(page.getByTestId("company-card")).first(),
        ).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const blocking = results.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
        expect(blocking).toEqual([]);
      });
    }
  }
}
