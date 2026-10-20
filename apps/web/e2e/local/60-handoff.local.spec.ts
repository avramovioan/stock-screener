/**
 * Local-stack end-to-end spec (P7 Task 4). Setup, once per session (PowerShell, repository root):
 *   bun run e2e:setup        # supabase start, db reset, users, fixture Flex statement, fixture scan, portfolio_scan checks
 *   bun run test:e2e:local   # ensures the seed, starts the Vite dev server on 5173, runs every spec in e2e/local
 * The service-role key reaches these specs through E2E_SERVICE_ROLE_KEY and never reaches the browser bundle.
 *
 * Hand-off: what it creates (and removes afterwards): one confirmed user with a linked broker connection (a bare row: nothing is synced),
 * the first card promoted to green if it is withheld, and ONE synthetic verified EUR line E2E1 (conid 900000099) for that card.
 */
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, request as pwRequest, test } from "@playwright/test";

const API = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.E2E_SERVICE_ROLE_KEY ?? "";
const PASSWORD = "E2e-Passw0rd-9x";
const PROMPT = "Create buy limit order for 10 shares of E2E1 at 400 and set destination IBIS2";

test.skip(!SERVICE, "needs E2E_SERVICE_ROLE_KEY (local stack only)");
test.skip(
  !["127.0.0.1", "localhost"].includes(new URL(API).hostname),
  "refusing to run against a non-local stack",
);

// one worker: beforeAll and afterAll seed and remove shared rows, so parallel workers would delete them under each other
test.describe.configure({ mode: "serial" });

interface FeedRow {
  withheld: boolean;
  scan_run_id: string;
  security_id: string;
  yahoo_symbol: string;
  operational_category: string;
  category_reason: string;
  conclusion: string | null;
  summary: string | null;
}

let svc: APIRequestContext;
let anon: APIRequestContext;
let card: FeedRow | null = null;
let promoted: Record<string, unknown> | null = null;
let userId: string | null = null;
const email = `e2e-handoff-${randomUUID()}@example.com`;

const cardFilter = (r: FeedRow) =>
  `scan_run_id=eq.${r.scan_run_id}&security_id=eq.${r.security_id}&mode=eq.worldwide`;

test.beforeAll(async () => {
  anon = await pwRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
    },
  });
  svc = await pwRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
    },
  });

  const feed = await anon.post("/rest/v1/rpc/todays_discounts_feed", {
    data: { p_mode: "worldwide" },
  });
  const rows = (await feed.json()) as FeedRow[];
  card = rows.find((r) => !r.withheld) ?? rows[0] ?? null;
  if (card === null) return;

  if (card.withheld) {
    promoted = {
      operational_category: card.operational_category,
      withheld: true,
      category_reason: card.category_reason,
      conclusion: card.conclusion,
      summary: card.summary,
    };
    const res = await svc.patch(`/rest/v1/todays_discounts?${cardFilter(card)}`, {
      data: {
        operational_category: "green",
        withheld: false,
        category_reason: "e2e promotion",
        conclusion: "e2e",
        summary: "e2e fixture card",
      },
    });
    expect(res.ok()).toBe(true);
  }

  const eur = await svc.post("/rest/v1/eur_equivalents?on_conflict=security_id,ibkr_exchange_id", {
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    data: {
      security_id: card.security_id,
      ibkr_exchange_id: "IBIS",
      ibkr_conid: 900000099,
      ibkr_local_symbol: "E2E1",
      eur_symbol_yahoo: "E2E1.DE",
      status: "verified",
      verification: {
        method: "automatic",
        failed: [],
        checks: { isin_confirmed: "pass", price_within_tolerance: "pass" },
      },
      verified_at: new Date().toISOString(),
    },
  });
  expect(eur.ok()).toBe(true);

  const created = await svc.post("/auth/v1/admin/users", {
    data: { email, password: PASSWORD, email_confirm: true },
  });
  expect(created.ok()).toBe(true);
  userId = ((await created.json()) as { id: string }).id;
  // the first sign-in step only continues for an e-mail on the invite list
  const invited = await svc.post("/rest/v1/invited_emails", {
    headers: { Prefer: "return=minimal" },
    data: { email },
  });
  expect(invited.ok()).toBe(true);
  const link = await svc.post("/rest/v1/broker_connections", {
    data: { user_id: userId, status: "linked" },
  });
  expect(link.ok()).toBe(true);
});

test.afterAll(async () => {
  if (card !== null) {
    await svc.delete(
      `/rest/v1/eur_equivalents?security_id=eq.${card.security_id}&ibkr_local_symbol=eq.E2E1`,
    );
    if (promoted !== null)
      await svc.patch(`/rest/v1/todays_discounts?${cardFilter(card)}`, { data: promoted });
  }
  await svc.delete(`/rest/v1/invited_emails?email=eq.${encodeURIComponent(email)}`);
  if (userId !== null) await svc.delete(`/auth/v1/admin/users/${userId}`); // cascades the connection and the profile
  await svc.dispose();
  await anon.dispose();
});

test("a visitor who is not signed in gets the Trade on IBKR button on the card, no sign-in link", async ({
  page,
}) => {
  expect(card, "the fixture scan published a card (bun run e2e:setup)").not.toBeNull();
  await page.goto("/");
  const cardEl = page.locator(`[data-testid="discount-card"][data-symbol="${card?.yahoo_symbol}"]`);
  await expect(cardEl.getByTestId("trade-on-ibkr-button")).toBeVisible();
  await expect(cardEl.getByRole("link", { name: "Sign in to trade" })).toHaveCount(0);
});

test("a linked user opens the hand-off from a card, gets the owner's prompt, and nothing is written", async ({
  page,
  context,
}) => {
  expect(card, "the fixture scan published a card (bun run e2e:setup)").not.toBeNull();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/auth/sign-in");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // the session is stored once the app has left the sign-in page; a goto before that would drop it
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"));
  await page.goto("/");

  const cardEl = page.locator(`[data-testid="discount-card"][data-symbol="${card?.yahoo_symbol}"]`);
  await expect(cardEl.getByTestId("trade-on-ibkr-button")).toHaveText("Trade on IBKR");

  const writes: string[] = [];
  page.on("request", (r) => {
    const own = r.url().startsWith(API);
    const read =
      r.method() === "GET" ||
      r.method() === "OPTIONS" ||
      r.url().includes("/rest/v1/rpc/") ||
      r.url().includes("/functions/v1/quotes/") ||
      r.url().includes("/auth/v1/token");
    if (own && !read) writes.push(`${r.method()} ${r.url()}`);
  });

  await cardEl.getByTestId("trade-on-ibkr-button").click();
  const dialog = page.getByTestId("trade-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("no-order-notice")).toContainText(
    "This app does not place orders.",
  );
  await expect(dialog.getByTestId("listing-badge")).toHaveAttribute("data-status", "verified");
  await expect(dialog.getByText("E2E1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("900000099")).toBeVisible();

  await dialog.getByLabel("Quantity (shares)").fill("10");
  await dialog.getByLabel("Limit price (EUR)").fill("400");
  await expect(dialog.getByTestId("ibot-prompt")).toHaveValue(PROMPT);
  await expect(dialog.getByTestId("ticket-checklist")).toHaveText(
    "On the ticket confirm: conid 900000099 / E2E1 / EUR / destination IBIS2",
  );

  const link = dialog.getByTestId("open-ibkr");
  await expect(link).toHaveAttribute("href", "https://www.interactivebrokers.com/sso/Login");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);

  await dialog.getByTestId("copy-prompt").click();
  await expect(dialog.getByTestId("copy-prompt")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);

  await dialog.getByLabel("Limit price (EUR)").fill("400,5");
  await expect(dialog.getByTestId("ibot-prompt")).toHaveCount(0);
  await expect(dialog.getByRole("alert").filter({ hasText: "dot" })).toBeVisible();

  expect(writes).toEqual([]);
});
