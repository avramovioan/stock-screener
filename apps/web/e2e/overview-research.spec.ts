import { expect, type Page, test } from "@playwright/test";
import { DISCOUNTS, stubApi } from "./support/stub-api";

test.use({ serviceWorkers: "block" });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
};

const base = DISCOUNTS[0] as Record<string, unknown>;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** A feed row with a given research state; every other column comes from the stub's MSFT row. */
function row(symbol: string, rank: number, over: Record<string, unknown>) {
  return {
    ...base,
    rank,
    security_id: `sid-${symbol.toLowerCase()}`,
    yahoo_symbol: symbol,
    name: `${symbol} Corp`,
    exchange_code: "NYQ",
    display_order: rank,
    ...over,
  };
}

const NO_REPORT = {
  operational_category: "pending",
  category_reason: "not_requested",
  withheld: true,
  conclusion: null,
  bankruptcy_risk: null,
  summary: null,
  research_completed_at: null,
  research_provider: null,
  research_model: null,
};

async function feed(page: Page, rows: unknown[]) {
  await page.route("**/rest/v1/rpc/todays_discounts_feed", (r) =>
    r.request().method() === "OPTIONS"
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill({ status: 200, headers: CORS, json: rows }),
  );
}

const card = (page: Page, symbol: string) =>
  page.locator(`[data-testid="discount-card"][data-symbol="${symbol}"]`);

test("a card shows each research state: not scanned, running, done, failed", async ({ page }) => {
  await stubApi(page);
  await feed(page, [
    row("NONE", 1, NO_REPORT),
    row("RUN", 2, {
      ...NO_REPORT,
      category_reason: "research_pending",
      research_started_at: minutesAgo(12),
      research_requested_by: "visitor",
    }),
    row("DONE", 3, { research_completed_at: minutesAgo(120) }),
    row("FAIL", 4, { ...NO_REPORT, research_failed_at: minutesAgo(90) }),
  ]);
  await page.goto("/");

  const none = card(page, "NONE");
  await expect(none.getByText("No AI research yet")).toBeVisible();
  await expect(none.getByRole("button", { name: "Scan with AI" })).toBeEnabled();
  await expect(none.getByRole("button", { name: "Copy the prompt", exact: true })).toBeVisible();
  await expect(none.getByRole("button", { name: "Open the prompt in ChatGPT" })).toBeVisible();

  const run = card(page, "RUN");
  await expect(run.getByText("AI research running")).toBeVisible();
  await expect(run.getByText(/^Started 12 minutes ago by a visitor\./)).toBeVisible();
  await expect(run.getByRole("button", { name: /Scan/ })).toHaveCount(0);
  await expect(
    run.getByRole("progressbar", { name: "AI research in progress" }),
  ).not.toHaveAttribute("aria-valuenow");

  const done = card(page, "DONE");
  await expect(done.getByText(/Researched by Gemini 3.5 Flash,/)).toBeVisible();
  await expect(done.getByText(/^A new scan can be requested from /)).toBeVisible();
  await expect(done.getByRole("button", { name: "Copy the prompt", exact: true })).toBeVisible();
  await expect(done.getByRole("button", { name: "Open the prompt in ChatGPT" })).toBeVisible();

  const fail = card(page, "FAIL");
  await expect(fail.getByText("The last scan failed")).toBeVisible();
  await expect(fail.getByRole("button", { name: "Scan with AI" })).toBeEnabled();
});

test("Scan with AI posts the security id and a refusal shows the limits state", async ({
  page,
}) => {
  await stubApi(page);
  await feed(page, [row("NONE", 1, NO_REPORT)]);
  const bodies: unknown[] = [];
  await page.route("**/functions/v1/research-request", async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    bodies.push(r.request().postDataJSON());
    return r.fulfill({
      status: 429,
      headers: CORS,
      json: { ok: false, reason: "network_limit" },
    });
  });
  await page.goto("/");
  await card(page, "NONE").getByRole("button", { name: "Scan with AI" }).click();
  await expect(card(page, "NONE").getByText("Scans are paused for now")).toBeVisible();
  await expect(card(page, "NONE").getByRole("button", { name: "Scan with AI" })).toBeDisabled();
  expect(bodies).toEqual([{ security_id: "sid-none" }]);
});

test("Scan with AI accepts the queued answer (a queued report id) and shows the running state", async ({
  page,
}) => {
  await stubApi(page);
  let started = false;
  await page.route("**/rest/v1/rpc/todays_discounts_feed", (r) =>
    r.request().method() === "OPTIONS"
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill({
          status: 200,
          headers: CORS,
          json: [
            row(
              "NONE",
              1,
              started
                ? {
                    ...NO_REPORT,
                    category_reason: "research_pending",
                    research_started_at: minutesAgo(0),
                    research_requested_by: "visitor",
                  }
                : NO_REPORT,
            ),
          ],
        }),
  );
  await page.route("**/functions/v1/research-request", async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    started = true;
    return r.fulfill({
      status: 200,
      headers: CORS,
      json: { ok: true, report_id: "rep-queued", started_at: new Date().toISOString() },
    });
  });
  await page.goto("/");
  await card(page, "NONE").getByRole("button", { name: "Scan with AI" }).click();
  await expect(card(page, "NONE").getByText("AI research running")).toBeVisible();
  await expect(card(page, "NONE").getByText("Scans are paused for now")).toHaveCount(0);
});

test("a 409 in_flight answer shows Scanning with the start it gives, no Scan button, and the feed catches up", async ({
  page,
}) => {
  await stubApi(page);
  await feed(page, [row("NONE", 1, NO_REPORT)]);
  await page.route("**/functions/v1/research-request", async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    return r.fulfill({
      status: 409,
      headers: CORS,
      json: {
        ok: false,
        reason: "in_flight",
        started_at: minutesAgo(1),
        requested_by: "visitor",
      },
    });
  });
  await page.goto("/");
  await card(page, "NONE").getByRole("button", { name: "Scan with AI" }).click();
  const c = card(page, "NONE");
  await expect(c.getByText("AI research running")).toBeVisible();
  await expect(
    c.getByText(/^Started 1 minute ago by a visitor\. Usually a few minutes\./),
  ).toBeVisible();
  await expect(c.getByRole("progressbar", { name: "AI research in progress" })).toBeVisible();
  await expect(c.getByRole("button", { name: /Scan with AI|Starting/ })).toHaveCount(0);
  await expect(c.getByText("Couldn't start the scan right now")).toHaveCount(0);
});

test("Listed in keeps a company that is listed on a US exchange whatever its home country", async ({
  page,
}) => {
  await stubApi(page);
  await feed(page, [
    row("US1", 1, { country: "United States", listing_country: "United States" }),
    row("AON", 2, { country: "United Kingdom", listing_country: "United States" }),
    row("TOY", 3, { country: "Japan", listing_country: "Japan" }),
  ]);
  await page.goto("/?country=us");
  const group = page.getByRole("radiogroup", { name: "Listed in" });
  await expect(group.getByRole("radio", { name: "United States" })).toBeChecked();
  await expect(page.getByTestId("discount-card")).toHaveCount(2);
  await expect(card(page, "AON")).toBeVisible();
  await expect(card(page, "TOY")).toHaveCount(0);
  await group.getByText("All exchanges", { exact: true }).click();
  await expect(page.getByTestId("discount-card")).toHaveCount(3);
});
