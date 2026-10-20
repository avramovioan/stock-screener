import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { ANON, api, feedRows, OWNER, SERVICE, signIn } from "./support/stack";

// The auth state is written to one file per viewport and scheme; the local config forces one worker anyway.
const AUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), ".auth");
const VIEWPORTS = [
  { name: "360", width: 360, height: 740 },
  { name: "1280", width: 1280, height: 800 },
] as const;

async function firstReportId(): Promise<string> {
  const ctx = await api(ANON);
  const res = await ctx.get("/rest/v1/research_reports?select=id&status=eq.complete&limit=1");
  const rows = res.ok() ? ((await res.json()) as Array<{ id: string }>) : [];
  await ctx.dispose();
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("no complete research report: run bun run e2e:setup");
  return id;
}

/** Page-specific proof that the real content (not a skeleton or an error state) is on screen. */
type Ready = (page: Page) => Promise<void>;
const ready = {
  overview: async (page) => {
    await expect(page.getByTestId("discount-card").first()).toBeVisible();
    await expect(
      page.getByTestId("company-row").or(page.getByTestId("company-card")).first(),
    ).toBeVisible();
  },
  quotes: async (page) => {
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.getByText(/Last completed close/)).toBeVisible();
  },
  heading: async (page) => {
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  },
  form: async (page) => {
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
  },
  report: async (page) => {
    await expect(page.getByTestId("source-item").first()).toBeVisible();
  },
  portfolio: async (page) => {
    await expect(
      page
        .locator('[data-testid="positions-table"]:visible, [data-testid="positions-cards"]:visible')
        .first(),
    ).toBeVisible();
    await expect(page.getByText("Broker data as of")).toBeVisible();
  },
  analytics: async (page) => {
    await expect(page.getByRole("table", { name: "Per-currency breakdown" })).toBeVisible();
  },
  security: async (page) => {
    await expect(page.getByRole("list", { name: "Linked sign-in methods" })).toBeVisible();
  },
  broker: async (page) => {
    await expect(page.getByText("Connection status")).toBeVisible();
    await expect(page.getByText("Linked", { exact: true }).first()).toBeVisible();
  },
} satisfies Record<string, Ready>;

async function audit(page: Page, label: string, scope?: string): Promise<void> {
  // axe reads the colours that are painted now: a dialog still fading in (opacity < 1) reads as low contrast
  // only finite animations are awaited (an infinite spinner never finishes) and the wait is bounded
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]),
  );
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (scope !== undefined) builder = builder.include(scope);
  const results = await builder.analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
  expect(blocking, label).toEqual([]);
}

async function checkPage(page: Page, path: string, isReady: Ready): Promise<void> {
  await page.goto(path);
  await isReady(page);
  // a page in an error state is a failure, not an audited page
  await expect(
    page.getByRole("alert").filter({ hasText: /could not|failed|error|went wrong/i }),
    `${path}: an error alert is shown`,
  ).toHaveCount(0);
  await audit(page, path);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${path}: horizontal page scroll`).toBeLessThanOrEqual(1);
}

/** A verified EUR line for the first card so the dialog shows its richest state; removed afterwards, a pre-existing row is never touched. */
async function seedListing(svc: APIRequestContext, securityId: string): Promise<boolean> {
  const existing = await svc.get(
    `/rest/v1/eur_equivalents?select=security_id&security_id=eq.${securityId}&ibkr_exchange_id=eq.IBIS`,
  );
  if (((await existing.json()) as unknown[]).length > 0) return false;
  const res = await svc.post("/rest/v1/eur_equivalents", {
    headers: { Prefer: "return=minimal" },
    data: {
      security_id: securityId,
      ibkr_exchange_id: "IBIS",
      ibkr_conid: 900000098,
      ibkr_local_symbol: "E2EA",
      eur_symbol_yahoo: "E2EA.DE",
      status: "verified",
      verification: {
        method: "automatic",
        failed: [],
        checks: { isin_confirmed: "pass", price_within_tolerance: "pass" },
      },
      verified_at: new Date().toISOString(),
    },
  });
  expect(res.ok()).toBe(true);
  return true;
}

for (const viewport of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${viewport.name}px ${scheme}`, () => {
      const authFile = join(AUTH_DIR, `owner-${viewport.name}-${scheme}.json`);
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("public pages", async ({ page }) => {
        const symbol = (await feedRows())[0]?.yahoo_symbol;
        expect(symbol, "the feed has a card").toBeTruthy();
        await checkPage(page, "/", ready.overview);
        await checkPage(page, "/?country=us", ready.overview);
        await checkPage(page, `/quotes?symbol=${encodeURIComponent(symbol ?? "")}`, ready.quotes);
        await checkPage(page, "/about", ready.heading);
        await checkPage(page, "/auth/sign-in", ready.form);
        await checkPage(page, `/research/${await firstReportId()}`, ready.report);
      });

      test.describe("signed in", () => {
        test.beforeAll(async ({ browser }) => {
          mkdirSync(AUTH_DIR, { recursive: true });
          const context = await browser.newContext({
            baseURL: test.info().project.use.baseURL ?? "http://localhost:5173",
            storageState: { cookies: [], origins: [] },
          });
          const page = await context.newPage();
          await signIn(page, OWNER);
          await expect(page).toHaveURL("/");
          await context.storageState({ path: authFile });
          await context.close();
        });
        test.use({ storageState: authFile });

        test("guarded pages", async ({ page }) => {
          await checkPage(page, "/portfolio", ready.portfolio);
          await checkPage(page, "/analytics", ready.analytics);
          await checkPage(page, "/profile/security", ready.security);
          await checkPage(page, "/profile/broker", ready.broker);
        });

        test("dialogs: the Trade on IBKR hand-off and the unlink confirmation", async ({
          page,
        }) => {
          const card = (await feedRows()).find((r) => !r.withheld);
          expect(card, "a visible card").toBeTruthy();
          const svc = await api(SERVICE);
          const seeded = await seedListing(svc, card?.security_id ?? "");
          try {
            await page.goto("/");
            const cardEl = page.locator(
              `[data-testid="discount-card"][data-symbol="${card?.yahoo_symbol}"]`,
            );
            await cardEl.getByTestId("trade-on-ibkr-button").click();
            const dialog = page.getByTestId("trade-dialog");
            await expect(dialog).toBeVisible();
            await expect(dialog.getByTestId("listing-badge")).toBeVisible();
            await expect(dialog.getByRole("alert")).toHaveCount(0);
            if (seeded) {
              await dialog.getByLabel("Quantity (shares)").fill("10");
              await dialog.getByLabel("Limit price (EUR)").fill("400");
              await expect(dialog.getByTestId("ibot-prompt")).toBeVisible();
            }
            await audit(page, "trade dialog", '[data-testid="trade-dialog"]');
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);

            await page.goto("/profile/broker");
            await ready.broker(page);
            await page.getByRole("button", { name: "Unlink" }).first().click();
            const confirm = page.getByRole("dialog", { name: "Unlink your IBKR account?" });
            await expect(confirm).toBeVisible();
            await audit(page, "unlink dialog", '[role="dialog"]');
            await page.keyboard.press("Escape");
            await expect(confirm).toHaveCount(0);
          } finally {
            if (seeded)
              await svc.delete(
                `/rest/v1/eur_equivalents?security_id=eq.${card?.security_id}&ibkr_local_symbol=eq.E2EA`,
              );
            await svc.dispose();
          }
        });
      });
    });
  }
}
